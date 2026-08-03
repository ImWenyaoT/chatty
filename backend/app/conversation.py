from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

from app.agent import Recommender
from app.models import ClarifyReply, RecommendationRequest, Reply, UserContext

ResolveContext = Callable[[list[str]], Awaitable[UserContext]]


class Conversation:
    def __init__(
        self,
        recommender: Recommender,
        user_id: str,
        resolve_context: ResolveContext,
    ) -> None:
        self.recommender = recommender
        self.user_id = user_id
        self.resolve_context = resolve_context

    async def send(
        self,
        said: list[str],
        history: list[dict[str, Any]],
    ) -> tuple[Reply, list[dict[str, Any]]]:
        request = RecommendationRequest(
            user_id=self.user_id,
            num_items=3,
            context=await self.resolve_context(said),
        )
        reply = await self.recommender.respond(request, history)
        # 推荐是会话终态，不需要再为下一轮保存模型历史。
        if not isinstance(reply, ClarifyReply):
            return reply, list(history)

        # 澄清后用户还会继续回答，因此要把本轮请求与问题都保存成
        # Agents SDK 认识的结构化消息，而不是普通字符串。
        user_history_item = {
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": request.model_dump_json(),
                }
            ],
        }
        assistant_history_item = {
            "role": "assistant",
            "status": "completed",
            "content": [
                {
                    "type": "output_text",
                    "text": json.dumps(
                        {
                            "action": "clarify",
                            "question": reply.question,
                        },
                        ensure_ascii=False,
                    ),
                }
            ],
        }
        next_history = list(history)
        next_history.append(user_history_item)
        next_history.append(assistant_history_item)
        return reply, next_history
