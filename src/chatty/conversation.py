"""会话：从开场白到给出推荐的完整过程。

这个 module 存在的理由是**协议只该有一份**。多轮里 Agent 反问时，那一问一答
要按 `{"action":"clarify","question":"…"}` 的形状记进 history，下一轮模型才知道
自己问过什么。早先这段拼装逐字重复在 demo 与多轮评估两处，chatty 自己完全不
知道它存在——协议一改，两处静默失配，而且没有任何测试盯着。

三个调用方真正不同的只有两件事，所以它们成了参数：

  · resolve —— 把用户说过的话转成结构化条件。demo 调模型解析大白话；
                评估按关键词匹配（要可复现，不能多引一次模型调用）。
  · ask     —— 拿到下一句用户回答。demo 是 input() 阻塞；评估是用户模拟器。

其余的（话语累积、history 形状、轮次上限、证据不跨轮）都在实现里，调用方看不见。

错误不在这里吞：RecommendationError 已经带了稳定的 code，原样往上抛。
transcript 与澄清次数也不在这里记——每次澄清恰好调用一次 ask，调用方在自己的
回调里想记什么记什么，抛异常了那些记录也还在它手上。
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable

from agents.items import TResponseInputItem

from chatty.agent import Recommender
from chatty.models import (
    ClarifyReply,
    RecommendationRequest,
    RecommendationResponse,
    UserContext,
)

# 用户说过的话 → 结构化条件
Resolve = Callable[[list[str]], Awaitable[UserContext]]
# Agent 的反问 → 用户的回答；返回 None 表示用户不答了
Ask = Callable[[str], Awaitable[str | None]]


class Conversation:
    """一次会话。一个实例跑一次，不复用。"""

    def __init__(
        self,
        recommender: Recommender,
        *,
        user_id: str,
        num_items: int = 3,
        max_turns: int = 3,
    ) -> None:
        if max_turns < 1:
            raise ValueError("max_turns 至少为 1，否则一轮都不会跑")
        self._recommender = recommender
        self._user_id = user_id
        self._num_items = num_items
        self._max_turns = max_turns

    async def converse(
        self,
        opening: str,
        *,
        resolve: Resolve,
        ask: Ask,
    ) -> RecommendationResponse | ClarifyReply:
        """跑到给出推荐为止，或者跑满轮次上限。

        返回 RecommendationResponse 表示成功给出了推荐；
        返回 ClarifyReply 表示轮次用完了它还在反问，或者用户中途不答了。
        """
        said = [opening]
        history: list[TResponseInputItem] = []
        last_question: ClarifyReply | None = None

        for turn in range(self._max_turns):
            # 每轮拿**全部**说过的话重新解析：第二轮用户只说「2000 以内」，
            # 单看这一句会丢掉第一轮说的类目。
            request = RecommendationRequest(
                user_id=self._user_id,
                num_items=self._num_items,
                context=await resolve(said),
            )
            reply = await self._recommender.respond(request, history=history)
            if isinstance(reply, RecommendationResponse):
                return reply

            last_question = reply
            # 最后一轮问了也没有下一轮来用这个答案，别浪费——demo 那边是让人白等一次
            # 输入，评估那边是白花一次用户模拟器的模型调用。
            if turn == self._max_turns - 1:
                break

            # 这一问一答记进 history，下一轮模型才看得见自己问过什么
            history.append({"role": "user", "content": request.model_dump_json()})
            history.append(
                {
                    "role": "assistant",
                    "content": json.dumps(
                        {"action": "clarify", "question": reply.question},
                        ensure_ascii=False,
                    ),
                }
            )
            answer = await ask(reply.question)
            if answer is None:
                break  # 用户不答了，把最后那个问题交回去
            said.append(answer)

        # 轮次耗尽或用户放弃。last_question 一定不是 None：循环至少跑一次，
        # 而唯一能走到这里的路径都经过了赋值。
        assert last_question is not None
        return last_question
