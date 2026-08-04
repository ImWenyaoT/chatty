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
    """只保留未完成澄清所需的消息；任务完成后下一轮从空 Context 开始。"""

    pending_user_messages: list[str] = field(default_factory=list)
    history: list[dict[str, Any]] = field(default_factory=list)
    turns: int = 0


@dataclass
class ChattyTurn:
    reply: Reply
    understood_as: str
    context: ChattyContext
    turns_left: int
    trace: list[str]
    usage: Usage
    latency_ms: float


class ChattyError(Exception):
    def __init__(self, code: str, diagnostics: dict[str, Any] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.diagnostics = diagnostics or {}


class ChattyAgent(Protocol):
    async def run(
        self, user_id: str, text: str, context: ChattyContext
    ) -> ChattyTurn: ...


class Chatty:
    """Chatty Agent 的单一外部 Interface；内部包含 Model 与 Harness。"""

    def __init__(self, catalog: Catalog, provider: ResponsesModelProvider) -> None:
        self.catalog = catalog
        self.provider = provider
        self.executor = ChattyExecutor(catalog, provider)

    async def run(self, user_id: str, text: str, context: ChattyContext) -> ChattyTurn:
        """执行一次 Context In / Context Out，不在 Chatty 内保存跨请求状态。"""

        started = time.perf_counter()
        if context.turns >= MAX_TURNS:
            raise ChattyError("conversation_exhausted")

        pending_messages = [*context.pending_user_messages, text]
        try:
            if not self.provider.configured:
                raise MissingCredentialsError("llm_not_configured")
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
            evidence = RecommendationEvidence()
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
            usage = Usage()
            usage.add(frame_result.context_wrapper.usage)
            usage.add(evidence.usage)
            latency_ms = (time.perf_counter() - started) * 1000
            history: list[dict[str, Any]] = []
            next_pending_messages: list[str] = []
            if isinstance(reply, ClarifyReply):
                next_pending_messages = pending_messages
                history = list(context.history)
                history.extend(_clarification_history(text, reply))
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
    steps = ["task_framing"]
    for tool_name in evidence.used_tools:
        if tool_name not in steps:
            steps.append(tool_name)
    steps.extend(["response_generation", "evidence_validation"])
    return steps


def _clarification_history(
    user_text: str,
    reply: ClarifyReply,
) -> list[dict[str, Any]]:
    """只保存还会进入下一轮的结构化 clarification 消息。"""

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
