"""ChattyRunModule：一次 POST /runs 的完整 run 循环（specs/runtime-eval.md §5）。

流程：会话属主校验 → runtime.sessions 开会话 → Runner.run（RunConfig 固定 workflow 名 /
trace_id / group_id / metadata，max_turns 走 SDK 缺省 10，trace 脱敏）→ 三条受控
恢复路径 forceHandoff → persist → RunResponse 组装（出站不变量在 trace 收尾前裁决，
违约以 RunFailure("run_contract_violated", trace_id) 对外）。

会话历史（表名、SQLiteSession 生命周期、属主规则）归 `chatty.session`；本模块只在
run 循环里用它，读历史的 HTTP 路径不经过这里，因而不需要任何 Model 配置。
"""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from agents import Agent, Model, RunConfig, Runner, SQLiteSession
from agents.exceptions import MaxTurnsExceeded, ModelBehaviorError
from pydantic import ValidationError

from chatty import config
from chatty.agent import build_agent, model_from_env
from chatty.contracts import RunResponse, run_status
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
from chatty.runtime import NativeRuntime
from chatty.tools import ToolExecutionState, build_chatty_tools
from chatty.tracing import RuntimeTracingRouter, install_runtime_tracing

DEFAULT_KNOWLEDGE_PATH = config.knowledge_path()


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

        构造代价只落在真正要跑 Agent 的路径上：读会话历史走 runtime.sessions，
        不经过本模块，因此缺 key 也照常返回历史。
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
            self.runtime.sessions.require_owner(
                session_id=resolved_session_id, customer_id=customer_id
            )
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
        # 步骤 5：claim 在受控块外（decisions §5.3，按 TS）——新会话 uuid 不会
        # 冲突、携带 session_id 的请求已通过 require_owner，异常实际不可达；
        # 万一发生则裸抛 → HTTP 500。
        self.runtime.sessions.claim(
            session_id=resolved_session_id, customer_id=customer_id
        )
        state = ToolExecutionState()
        agent = build_agent(
            model=self._model,
            tools=build_chatty_tools(state=state, knowledge_store=self.runtime.knowledge),
        )
        with self.runtime.sessions.open(resolved_session_id) as session:
            self._tracing.register(trace_id, self.runtime.traces)
            try:
                try:
                    result = await self._run_agent(agent, context, state, session)
                    persist_agent_run(context, result)
                    # 出站不变量在 trace 收尾前裁决：违约不会留下"已 completed 却被
                    # 拒绝"的 trace，也不会绕过 RunFailure 变成裸 500。
                    response = self._response(
                        result,
                        customer_id=customer_id,
                        session_id=resolved_session_id,
                        trace_id=trace_id,
                        request_id=resolved_request_id,
                    )
                    # processor 的 on_trace_end 已置 completed；显式 complete 双保险（幂等）。
                    self.runtime.traces.complete(trace_id)
                except RunFailure:
                    raise
                except HandoffIdempotencyConflictError as error:
                    persist_agent_failure(
                        self.runtime.traces, trace_id, "handoff_idempotency_conflict"
                    )
                    raise RunFailure("handoff_idempotency_conflict", trace_id) from error
                except HandoffPersistenceError as error:
                    persist_agent_failure(
                        self.runtime.traces, trace_id, "handoff_persistence_failed"
                    )
                    raise RunFailure("handoff_persistence_failed", trace_id) from error
                except Exception as error:
                    persist_agent_failure(self.runtime.traces, trace_id, "llm_provider_failed")
                    raise RunFailure(
                        "llm_provider_failed",
                        trace_id,
                        internal_error_name=type(error).__name__,
                    ) from error
            finally:
                self._tracing.discard(trace_id)
        return response

    def _response(
        self,
        result: AgentRunResult,
        *,
        customer_id: str,
        session_id: str,
        trace_id: str,
        request_id: str,
    ) -> RunResponse:
        """组装出站响应：status 由 contracts.run_status 派生，同一模块的 validator 复算。

        两者不一致（或证据形态违约）时以 RunFailure("run_contract_violated", trace_id)
        对外——trace 同时置 failed，不会留下一个"成功"的 trace 配一个 5xx 响应。
        """
        try:
            return RunResponse(
                reply=result.reply,
                customer_id=customer_id,
                session_id=session_id,
                trace_id=trace_id,
                request_id=request_id,
                status=run_status(
                    business_outcome=result.business_outcome,
                    support_request_id=result.support_request_id,
                ),
                business_outcome=result.business_outcome,
                completion_evidence=result.completion_evidence,
                knowledge_search_results=result.knowledge_search_results,
                memory_events=result.memory_events,
                needs_human=result.support_request_id is not None,
                support_request_id=result.support_request_id,
            )
        except ValidationError as error:
            persist_agent_failure(self.runtime.traces, trace_id, "run_contract_violated")
            raise RunFailure("run_contract_violated", trace_id) from error

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
