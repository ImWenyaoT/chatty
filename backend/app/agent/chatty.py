"""Chatty 的外层 Harness：理解任务、执行 Agent，并整理本轮状态。

阅读这个文件时，可以把一次请求理解成下面的数据流：

用户原话 + 上一轮待澄清内容
    -> Task Framer 把自然语言整理成 TaskFrame
    -> Harness 从 SQLite 准备确定性的 TaskContext
    -> ChattyExecutor 运行主 Agent，调用 Tool 并校验 Evidence
    -> ChattyTurn 把回复、新 Context、Trace 和 Usage 一起交还 HTTP 层

Model 负责理解和生成；这个文件负责调用顺序、错误边界和 Context In/Out。
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from agents import Runner
from agents.exceptions import MaxTurnsExceeded, ModelBehaviorError, ModelRefusalError
from agents.usage import Usage

from app.agent.evidence import RecommendationEvidence
from app.agent.executor import (
    ChattyExecutor,
    RecommendationError,
    prepare_task_context,
)
from app.agent.framing import (
    TaskFrameParseError,
    build_task_frame_agent,
    describe_task_frame,
    parse_task_frame,
    recover_invalid_task_frame,
)
from app.data.catalog import Catalog, CatalogError
from app.data.models import ClarifyReply, Reply
from app.model_provider import MissingCredentialsError, ResponsesModelProvider

MAX_TURNS = 3


@dataclass
class ChattyContext:
    """一次会话中需要带入下一轮的最小状态。

    pending_user_messages 给 Task Framer 看，让“200 元左右”这种短回答能补全上一轮问题；
    history 给主 Agent 看，避免它忘记自己问过什么；turns 用来限制澄清次数。
    一旦给出完整回答或推荐，这些内容就会清空。
    """

    pending_user_messages: list[str] = field(default_factory=list)
    history: list[dict[str, Any]] = field(default_factory=list)
    turns: int = 0


@dataclass
class ChattyTurn:
    """`run()` 的完整输出，HTTP 层只需要认识这一个结果对象。"""

    # reply 是用户真正看到的领域结果：回答、推荐或澄清问题。
    reply: Reply
    # understood_as 用于 UI 展示 Task Framer 怎样理解了用户原话。
    understood_as: str
    # context 必须由调用方保存，并在下一轮原样传回。
    context: ChattyContext
    turns_left: int
    # trace、usage 和 latency_ms 只用于解释与观察，不参与业务判断。
    trace: list[str]
    usage: Usage
    latency_ms: float


class ChattyError(Exception):
    """Chatty 对外只暴露稳定错误码，底层异常通过异常链保留。"""

    def __init__(self, code: str, diagnostics: dict[str, Any] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.diagnostics = diagnostics or {}


class ChattyAgent(Protocol):
    """HTTP 层依赖的最小 Interface；测试可传入实现相同方法的 Fake。"""

    async def run(
        self, user_id: str, text: str, context: ChattyContext
    ) -> ChattyTurn: ...


class Chatty:
    """Chatty Agent 的单一外部 Interface；内部包含 Model 与 Harness。

    Chatty 本身不保存用户会话。HTTP 层传入旧 ChattyContext，本方法返回新
    ChattyContext，因此状态的所有权始终清楚，也方便测试单独执行任意一轮。
    """

    def __init__(self, catalog: Catalog, provider: ResponsesModelProvider) -> None:
        self.catalog = catalog
        self.provider = provider
        self.executor = ChattyExecutor(catalog, provider)

    async def run(self, user_id: str, text: str, context: ChattyContext) -> ChattyTurn:
        """完成一轮 Context In / Context Out。

        Context In 是 user_id、当前原话和旧 ChattyContext；Context Out 是包含领域回复
        与新 ChattyContext 的 ChattyTurn。方法内部依次完成 framing、执行、整理状态。
        """

        # 计时覆盖 Task Framer 和主 Agent，表示用户等待这一整轮的时间。
        started = time.perf_counter()

        # turns 在进入模型前检查，避免已经耗尽的会话继续产生费用。
        if context.turns >= MAX_TURNS:
            raise ChattyError("conversation_exhausted")

        # Task Framer 需要看到所有待补全的原话；主 Agent 仍只接收当前 text 和 history。
        pending_messages = [*context.pending_user_messages, text]
        try:
            if not self.provider.configured:
                raise MissingCredentialsError("llm_not_configured")

            # 第一步只把自然语言整理成业务字段，不搜索商品，也不生成答案。
            frame_result = await Runner.run(
                build_task_frame_agent(self.provider, self.catalog.categories),
                "\n".join(
                    f"用户第{index}轮：{message}"
                    for index, message in enumerate(pending_messages, start=1)
                ),
                max_turns=1,
                error_handlers={
                    "invalid_final_output": recover_invalid_task_frame,
                },
            )
            frame = parse_task_frame(
                frame_result.final_output,
                self.catalog.categories,
            )

            # Evidence 是本轮新建的 Harness 账本。它不会跨轮累积，也不会由 Model 填写。
            evidence = RecommendationEvidence()

            # 第二步先从 SQLite 准备画像、候选和库存等确定性 Context，再运行主 Agent。
            task_context = prepare_task_context(
                frame,
                user_id,
                self.catalog,
                evidence,
            )
            reply = await self.executor.respond(
                task_context,
                evidence,
                text,
                context.history,
            )

            # 一轮会调用两个 Model：Task Framer 和主 Agent，所以在这里合并 Usage。
            usage = Usage()
            usage.add(frame_result.context_wrapper.usage)
            usage.add(evidence.usage)
            latency_ms = (time.perf_counter() - started) * 1000

            # 默认清空 Context。只有澄清尚未完成时，才覆盖为空列表以外的值。
            history: list[dict[str, Any]] = []
            next_pending_messages: list[str] = []
            if isinstance(reply, ClarifyReply):
                next_pending_messages = pending_messages
                history = list(context.history)
                history.extend(_clarification_history(text, reply))

        # 这里把不同依赖的异常翻译成少量稳定错误码，HTTP 层不需要认识 SDK 异常。
        except MissingCredentialsError as error:
            raise ChattyError("llm_not_configured") from error
        except TaskFrameParseError as error:
            raise ChattyError("task_frame_parse_failed") from error
        except (MaxTurnsExceeded, ModelBehaviorError, ModelRefusalError) as error:
            raise ChattyError("task_frame_parse_failed") from error
        except RecommendationError as error:
            raise ChattyError(error.code, error.diagnostics) from error
        except CatalogError as error:
            raise ChattyError(str(error)) from error

        # Chatty 不修改传入的 context，而是创建下一份状态交给调用方。
        next_context = ChattyContext(
            pending_user_messages=next_pending_messages,
            history=history,
            turns=context.turns + 1,
        )
        return ChattyTurn(
            reply=reply,
            understood_as=describe_task_frame(frame),
            context=next_context,
            turns_left=MAX_TURNS - next_context.turns,
            trace=_trace_steps(evidence),
            usage=usage,
            latency_ms=latency_ms,
        )


def _trace_steps(evidence: RecommendationEvidence) -> list[str]:
    """把 Harness 真实记录过的 Tool 整理成适合 UI 展示的简短 Trace。"""

    steps = ["task_framing"]
    for tool_name in evidence.used_tools:
        # 同一个 Tool 可能重试多次，UI 只展示它是否参与过，不展示重复名称。
        if tool_name not in steps:
            steps.append(tool_name)
    steps.extend(["response_generation", "evidence_validation"])
    return steps


def _clarification_history(
    user_text: str,
    reply: ClarifyReply,
) -> list[dict[str, Any]]:
    """把本轮澄清转换成 Agents SDK 下一轮可读取的消息格式。

    保存结构化 action、question 和 answer，而不是整份 RunResult；这样下一轮既知道
    Agent 问过什么，也不会把上一轮的 Tool Result 和临时 Evidence 全部带进去。
    """

    return [
        {
            "role": "user",
            "content": [{"type": "input_text", "text": user_text}],
        },
        {
            "role": "assistant",
            "status": "completed",
            "content": [
                {
                    "type": "output_text",
                    "text": json.dumps(
                        {
                            "action": "clarify",
                            "question": reply.question,
                            "answer": reply.answer,
                        },
                        ensure_ascii=False,
                    ),
                }
            ],
        },
    ]
