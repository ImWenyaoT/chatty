"""ChattyRunModule：一次 POST /runs 的完整 run 循环（specs/runtime-eval.md §5）。

流程：会话属主校验 → SDK SQLiteSession → Runner.run（RunConfig 固定 workflow 名 /
trace_id / group_id / metadata，max_turns 走 SDK 缺省 10，trace 脱敏）→ 三条受控
恢复路径 forceHandoff → persist → RunResponse 组装（出站不变量由 contracts 校验）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

from agents import Agent, Model, RunConfig, Runner, SQLiteSession
from agents.exceptions import MaxTurnsExceeded, ModelBehaviorError

from chatty import config
from chatty.agent import build_agent, model_from_env
from chatty.contracts import RunResponse, RunStatus
from chatty.harness import (
    AgentContext,
    AgentRunResult,
    HandoffIdempotencyConflictError,
    HandoffPersistenceError,
    InvalidAgentOutputError,
    RunFailure,
    complete_agent_run,
    force_handoff,
    persist_agent_failure,
    persist_agent_run,
)
from chatty.memory import SessionCustomerMismatchError, SessionNotFoundError
from chatty.runtime import NativeRuntime
from chatty.tools import ToolExecutionState, build_chatty_tools
from chatty.tracing import RuntimeTracingRouter, install_runtime_tracing

SESSIONS_TABLE = "chatty_sessions"
MESSAGES_TABLE = "chatty_messages"

DEFAULT_KNOWLEDGE_PATH = config.knowledge_path()

# business_outcome → 非 handoff run 的对外 status（§5.5）。
_STATUS_BY_OUTCOME: dict[str, RunStatus] = {
    "verified": "completed",
    "not_completed": "not_completed",
    "not_applicable": "responded",
}


class ChattyRunModule:
    """Agent run 的编排层；stores 归 NativeRuntime 所有（module 只关自己的 client）。"""

    def __init__(
        self,
        runtime: NativeRuntime,
        *,
        model: Model | None = None,
        model_id: str | None = None,
        base_url: str | None = None,
        knowledge_path: str | Path | None = None,
    ) -> None:
        """live 模式（model=None）缺 OPENAI_API_KEY 时在此抛 RunFailure("llm_not_configured")
        （decisions §5.2：HTTP 层懒构造并映射 503）；注入模式不建 client、不读 key。
        """
        self.runtime = runtime
        self._client = None
        if model is not None:
            self._model = model
            self._model_id = model_id or "injected-model"
        else:
            self._model, self._model_id, self._client = model_from_env(
                model_id=model_id, base_url=base_url
            )
        self._tracing: RuntimeTracingRouter = install_runtime_tracing()
        runtime.knowledge.import_jsonl(knowledge_path or DEFAULT_KNOWLEDGE_PATH)

    @property
    def model_id(self) -> str:
        return self._model_id

    async def close(self) -> None:
        """关闭 live 模式的 AsyncOpenAI client（注入模式为 no-op）。"""
        if self._client is not None:
            await self._client.close()

    async def run(
        self,
        *,
        message: str,
        customer_id: str,
        session_id: str | None = None,
        request_id: str | None = None,
    ) -> RunResponse:
        """§5.1 顺序严格的 run 流程；失败以 RunFailure(code, trace_id) 对外。"""
        resolved_request_id = request_id or f"request_{uuid4().hex}"
        resolved_session_id = session_id or f"session_{uuid4().hex}"
        # 步骤 2：仅当请求携带 session_id 时校验会话属主（此时尚无 trace_id）。
        if session_id:
            self._require_session(resolved_session_id, customer_id)
        trace_id = f"trace_{uuid4().hex}"
        context = AgentContext(
            customer_id=customer_id,
            session_id=resolved_session_id,
            commerce=self.runtime.commerce,
            artifacts=self.runtime.artifacts,
            message=message,
            trace_id=trace_id,
            request_id=resolved_request_id,
            memory_store=self.runtime.memory,
            support_store=self.runtime.support,
            trace_store=self.runtime.traces,
        )
        # 步骤 5：bindSession 在受控块外（decisions §5.3，按 TS）——新会话 uuid 不会
        # 冲突、携带 session_id 的请求已通过 require_session，异常实际不可达；
        # 万一发生则裸抛 → HTTP 500。
        self.runtime.memory.bind_session(
            session_id=resolved_session_id, customer_id=customer_id
        )
        state = ToolExecutionState()
        agent = build_agent(
            model=self._model,
            tools=build_chatty_tools(state=state, knowledge_store=self.runtime.knowledge),
        )
        session = SQLiteSession(
            resolved_session_id,
            db_path=self.runtime.database_path,
            sessions_table=SESSIONS_TABLE,
            messages_table=MESSAGES_TABLE,
        )
        self._tracing.register(trace_id, self.runtime.traces)
        try:
            try:
                result = await self._run_agent(agent, context, state, session)
                persist_agent_run(context, result)
                # processor 的 on_trace_end 已置 completed；显式 complete 双保险（幂等）。
                self.runtime.traces.complete(trace_id)
            except HandoffIdempotencyConflictError as error:
                persist_agent_failure(
                    self.runtime.traces, trace_id, "handoff_idempotency_conflict"
                )
                raise RunFailure("handoff_idempotency_conflict", trace_id) from error
            except HandoffPersistenceError as error:
                persist_agent_failure(self.runtime.traces, trace_id, "handoff_persistence_failed")
                raise RunFailure("handoff_persistence_failed", trace_id) from error
            except Exception as error:
                persist_agent_failure(self.runtime.traces, trace_id, "llm_provider_failed")
                raise RunFailure(
                    "llm_provider_failed",
                    trace_id,
                    internal_error_name=type(error).__name__,
                ) from error
        finally:
            session.close()
            self._tracing.discard(trace_id)
        needs_human = result.support_request_id is not None
        status = (
            "needs_human" if needs_human else _STATUS_BY_OUTCOME[result.business_outcome]
        )
        return RunResponse(
            reply=result.reply,
            customer_id=customer_id,
            session_id=resolved_session_id,
            trace_id=trace_id,
            request_id=resolved_request_id,
            status=status,
            business_outcome=result.business_outcome,
            completion_evidence=result.completion_evidence,
            knowledge_search_results=result.knowledge_search_results,
            memory_events=result.memory_events,
            needs_human=needs_human,
            support_request_id=result.support_request_id,
        )

    async def session_messages(
        self, *, session_id: str, customer_id: str
    ) -> list[dict[str, Any]]:
        """§5.7：属主校验后返回存储态消息 JSON 列表（SDK 原生格式，不做转换）。

        错误映射由 HTTP 层完成：session_not_found → 404，mismatch → 409。
        """
        self._require_session(session_id, customer_id)
        session = SQLiteSession(
            session_id,
            db_path=self.runtime.database_path,
            sessions_table=SESSIONS_TABLE,
            messages_table=MESSAGES_TABLE,
        )
        try:
            items = await session.get_items()
        finally:
            session.close()
        return [dict(item) for item in items]

    async def _run_agent(
        self,
        agent: Agent[AgentContext],
        context: AgentContext,
        state: ToolExecutionState,
        session: SQLiteSession,
    ) -> AgentRunResult:
        """Runner 调用 + §5.3 受控恢复（内层 catch）。"""
        try:
            sdk_result = await Runner.run(
                agent,
                context.message,
                context=context,
                session=session,
                run_config=RunConfig(
                    workflow_name="Chatty Agent Run",
                    trace_id=context.trace_id,
                    group_id=context.session_id,
                    trace_metadata={"model_id": self._model_id},
                    trace_include_sensitive_data=False,
                ),
            )
            attempted_tool_names: list[str] = []
            for item in sdk_result.new_items:
                if getattr(item, "type", None) != "tool_call_item":
                    continue
                tool_name = getattr(item, "tool_name", None)
                if isinstance(tool_name, str):
                    attempted_tool_names.append(tool_name)
            return complete_agent_run(
                context,
                final_output=sdk_result.final_output,
                interrupted=bool(sdk_result.interruptions),
                attempted_tool_names=attempted_tool_names,
                knowledge_search_results=state.knowledge_search_results,
            )
        except (ModelBehaviorError, InvalidAgentOutputError):
            context.prior_actions.append("model_tool_call:rejected")
            return force_handoff(
                context,
                reason="Harness 拒绝无效操作",
                details="Model 请求了无效或不可用的 Tool",
                knowledge_search_results=state.knowledge_search_results,
            )
        except MaxTurnsExceeded:
            context.prior_actions.append("agent_loop:max_turns")
            return force_handoff(
                context,
                reason="Harness 安全恢复已耗尽",
                details="Agent 在受限 turns 内未完成处理",
                knowledge_search_results=state.knowledge_search_results,
            )

    def _require_session(self, session_id: str, customer_id: str) -> None:
        try:
            self.runtime.memory.require_session(
                session_id=session_id, customer_id=customer_id
            )
        except SessionNotFoundError as error:
            raise RunFailure("session_not_found") from error
        except SessionCustomerMismatchError as error:
            raise RunFailure("session_customer_mismatch") from error
