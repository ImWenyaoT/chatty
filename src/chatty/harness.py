"""Chatty Harness：受信状态、业务回执与强制升级规则。

项目公理 Agent = Model + Harness：Model 只产出文本与 tool call；身份注入、
回执（receipt）、SQLite 重读核验、handoff 强制升级全部由本模块（Harness）完成。
规格来源：specs/harness-tools.md §2/§3/§6-§9 + decisions.md §2。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

from agents.exceptions import ModelBehaviorError
from pydantic import ValidationError

from chatty.artifacts import ArtifactStore
from chatty.commerce import CommerceError, CommerceStore
from chatty.contracts import KnowledgeRecord, MemoryEvent, Order
from chatty.memory import MemoryStore
from chatty.support import SupportRequestIdempotencyConflictError, SupportRequestStore
from chatty.traces import TraceStore

BusinessOutcome = Literal["verified", "not_completed", "not_applicable"]

# 参与 verify_business_outcome 优先级判断的 mutation tool 集合（§6.3）。
MUTATION_TOOLS = frozenset(
    {
        "create_order",
        "confirm_order",
        "cancel_order",
        "save_research_artifact",
        "save_content_artifact",
        "export_artifact",
    }
)


class InvalidAgentOutputError(RuntimeError):
    """模型最终输出违反 Harness 输出不变量（如引用知识但不附 source）。"""


class HandoffPersistenceError(RuntimeError):
    """support receipt 无法持久化。"""


class HandoffIdempotencyConflictError(RuntimeError):
    """同一 handoff 幂等 key 携带了不同证据。"""


class RunFailure(RuntimeError):
    """Run 循环对外失败分类（§9.2）；HTTP 层按 code 映射状态码。"""

    def __init__(
        self,
        code: str,
        trace_id: str | None = None,
        *,
        internal_error_name: str | None = None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.trace_id = trace_id
        # 内部字段：只进日志/trace，不进 HTTP 响应（decisions §5.5）。
        self.internal_error_name = internal_error_name


# RunFailure code → HTTP 状态码（§9.2）。
# 注意：`session_not_found` 在 GET /sessions/:id/messages 场景由 HTTP 层改判 404。
RUN_FAILURE_HTTP_STATUS: dict[str, int] = {
    "session_not_found": 409,
    "session_customer_mismatch": 409,
    "llm_not_configured": 503,
    "handoff_idempotency_conflict": 409,
    "handoff_persistence_failed": 500,
    "llm_provider_failed": 502,
}


def run_failure_http_status(code: str) -> int:
    """未知 code 一律按"其他一切异常"落 502。"""
    return RUN_FAILURE_HTTP_STATUS.get(code, 502)


def error_code(error: Exception) -> str:
    """回执错误码（§3）。

    参数校验错误固定为 `invalid_tool_input`：pydantic ValidationError（Harness 层
    二次校验）与 ModelBehaviorError（SDK 层 strict schema 校验，decisions §2.4）
    统一映射；其余异常取 str(error)。
    """
    if isinstance(error, ValidationError | ModelBehaviorError):
        return "invalid_tool_input"
    return str(error)


@dataclass(frozen=True)
class BusinessToolReceipt:
    """业务/artifact tool 每次调用（成功或失败）恰好一条的回执（§3/§6.3）。"""

    tool_name: str
    ok: bool
    order_id: str | None = None
    expected_status: str | None = None
    artifact_id: str | None = None
    expected_artifact_status: str | None = None
    delivery_id: str | None = None
    expected_content_hash: str | None = None
    evidence: str | None = None
    error: str | None = None


@dataclass
class HarnessContext:
    """业务核验层状态：受信身份 + 回执/prior_actions 追加式记录（§2）。"""

    customer_id: str
    session_id: str
    commerce: CommerceStore
    artifacts: ArtifactStore
    business_receipts: list[BusinessToolReceipt] = field(default_factory=list)
    prior_actions: list[str] = field(default_factory=list)

    def record_read_success(self, tool_name: str, evidence: str) -> None:
        self.prior_actions.append(f"{tool_name}:ok")
        self.business_receipts.append(
            BusinessToolReceipt(tool_name=tool_name, ok=True, evidence=evidence)
        )

    def record_order_success(self, tool_name: str, order: Order) -> None:
        self.prior_actions.append(f"{tool_name}:ok")
        self.business_receipts.append(
            BusinessToolReceipt(
                tool_name=tool_name,
                ok=True,
                order_id=order.id,
                expected_status=order.status,
            )
        )

    def record_artifact_success(self, tool_name: str, artifact_id: str, status: str) -> None:
        self.prior_actions.append(f"{tool_name}:ok")
        self.business_receipts.append(
            BusinessToolReceipt(
                tool_name=tool_name,
                ok=True,
                artifact_id=artifact_id,
                expected_artifact_status=status,
            )
        )

    def record_delivery_success(self, tool_name: str, delivery_id: str, content_hash: str) -> None:
        self.prior_actions.append(f"{tool_name}:ok")
        self.business_receipts.append(
            BusinessToolReceipt(
                tool_name=tool_name,
                ok=True,
                delivery_id=delivery_id,
                expected_content_hash=content_hash,
            )
        )

    def record_failure(self, tool_name: str, error: Exception) -> None:
        self.prior_actions.append(f"{tool_name}:failed")
        self.business_receipts.append(
            BusinessToolReceipt(tool_name=tool_name, ok=False, error=error_code(error))
        )

    def verify_business_outcome(self) -> tuple[BusinessOutcome, str | None]:
        """8 步业务结果核验（§7）：回执是唯一输入，SQLite 重读是唯一证据。

        语义债（decisions §2.2）：核验不一致沿用 TS 现状抛 CommerceError，
        落 run 循环通用分支 → RunFailure("llm_provider_failed") → HTTP 502；
        本应有专用错误码。
        """
        if not self.business_receipts:
            return "not_applicable", None
        mutations = [r for r in self.business_receipts if r.tool_name in MUTATION_TOOLS]
        latest = mutations[-1] if mutations else self.business_receipts[-1]
        if not latest.ok:
            return "not_completed", f"{latest.tool_name}:{latest.error}"
        if latest.delivery_id is not None and latest.expected_content_hash is not None:
            delivery = self.artifacts.get_delivery(latest.delivery_id, self.customer_id)
            if delivery.content_hash != latest.expected_content_hash:
                raise CommerceError("unverified_business_outcome")
            return "verified", f"delivery:{delivery.id}:{delivery.content_hash}"
        if latest.evidence is not None:
            return "verified", latest.evidence
        if latest.artifact_id is not None and latest.expected_artifact_status is not None:
            artifact = self.artifacts.get(latest.artifact_id)
            if artifact.status != latest.expected_artifact_status:
                raise CommerceError("unverified_business_outcome")
            return "verified", f"artifact:{artifact.id}:{artifact.status}"
        if latest.order_id is None or latest.expected_status is None:
            raise CommerceError("missing_completion_evidence")
        persisted = self.commerce.get_order(latest.order_id)
        if persisted.status != latest.expected_status:
            raise CommerceError("unverified_business_outcome")
        return "verified", f"{latest.tool_name}:{persisted.id}:{persisted.status}"


@dataclass(kw_only=True)
class AgentContext(HarnessContext):
    """单次 run 层状态：每次 run 新建，所有 tool 在同一 context 上追加（§2）。"""

    message: str
    trace_id: str
    request_id: str
    memory_store: MemoryStore
    support_store: SupportRequestStore
    trace_store: TraceStore
    memory_events: list[MemoryEvent] = field(default_factory=list)
    support_request_id: str | None = None


@dataclass(frozen=True)
class AgentRunResult:
    """Harness 内部 run 结果（§1）。"""

    reply: str
    knowledge_search_results: list[KnowledgeRecord]
    memory_events: list[MemoryEvent]
    business_outcome: BusinessOutcome
    completion_evidence: str | None
    support_request_id: str | None


def handoff_idempotency_key(context: AgentContext) -> str:
    """同一 run 内模型 create_handoff 与 Harness 强制升级共用同一 key（§4.4）。"""
    return f"{context.customer_id}:{context.session_id}:{context.request_id}:handoff"


def create_handoff_receipt(
    context: AgentContext, *, reason: str, model_context: str
) -> dict[str, str]:
    """tool `create_handoff` 的 Harness 实现（§8.1）。

    context 列存客户消息（strip 后），模型的 context 参数存 model_context 列。
    失败路径不在此追加 prior_actions：decisions §2.3 采用干净语义，统一由
    execute_chatty_tool 的 record_failure 记一条 `create_handoff:failed` 与一条失败回执。
    """
    try:
        receipt = context.support_store.create(
            customer_id=context.customer_id,
            session_id=context.session_id,
            reason=reason,
            context=context.message.strip(),
            model_context=model_context,
            prior_actions=list(context.prior_actions),
            idempotency_key=handoff_idempotency_key(context),
        )
    except SupportRequestIdempotencyConflictError as error:
        raise HandoffIdempotencyConflictError("handoff_idempotency_conflict") from error
    except Exception as error:
        context.trace_store.record_tool_event(
            context.trace_id, status="failed", summary="create_handoff failed"
        )
        raise HandoffPersistenceError("handoff receipt could not be persisted") from error
    context.support_request_id = receipt.id
    context.trace_store.record_tool_event(
        context.trace_id, status="completed", summary="create_handoff created receipt"
    )
    return {"support_request_id": receipt.id, "status": receipt.status}


def force_handoff(
    context: AgentContext,
    *,
    reason: str,
    details: str,
    knowledge_search_results: Mapping[str, KnowledgeRecord],
) -> AgentRunResult:
    """Harness 强制升级（§8.2）：与 create_handoff 共用同一幂等 key。"""
    try:
        receipt = context.support_store.create(
            customer_id=context.customer_id,
            session_id=context.session_id,
            reason=reason,
            context=context.message.strip(),
            model_context=details,
            prior_actions=list(context.prior_actions),
            idempotency_key=handoff_idempotency_key(context),
        )
    except SupportRequestIdempotencyConflictError as error:
        raise HandoffIdempotencyConflictError("handoff_idempotency_conflict") from error
    except Exception as error:
        context.trace_store.record_tool_event(
            context.trace_id, status="failed", summary="Harness-enforced handoff receipt failed"
        )
        raise HandoffPersistenceError("handoff receipt could not be persisted") from error
    context.trace_store.record_tool_event(
        context.trace_id, status="completed", summary="Harness-enforced handoff receipt created"
    )
    return _handoff_result(
        context,
        reply="业务无法安全完成，已创建可追踪的人工支持请求。",
        support_request_id=receipt.id,
        knowledge_search_results=knowledge_search_results,
    )


def complete_agent_run(
    context: AgentContext,
    *,
    final_output: object,
    interrupted: bool,
    attempted_tool_names: Sequence[str],
    knowledge_search_results: Mapping[str, KnowledgeRecord],
) -> AgentRunResult:
    """Run 正常返回后的强制规则（§8.3，按序执行）。"""
    if interrupted:
        context.prior_actions.append("tool_permission:approval_required")
        return force_handoff(
            context,
            reason="Harness 需要人工权限或授权",
            details="Tool 权限边界中断了同步执行",
            knowledge_search_results=knowledge_search_results,
        )
    if not isinstance(final_output, str) or not final_output.strip():
        return force_handoff(
            context,
            reason="Harness 安全恢复已耗尽",
            details="Agent 未返回可验证的客户结果",
            knowledge_search_results=knowledge_search_results,
        )
    if "create_handoff" in attempted_tool_names and context.support_request_id is None:
        return force_handoff(
            context,
            reason="Harness 强制升级",
            details="create_handoff 调用失败或参数无效",
            knowledge_search_results=knowledge_search_results,
        )
    if context.support_request_id is not None:
        return _handoff_result(
            context,
            reply=final_output,
            support_request_id=context.support_request_id,
            knowledge_search_results=knowledge_search_results,
        )
    if knowledge_search_results and not any(
        record.source in final_output for record in knowledge_search_results.values()
    ):
        raise InvalidAgentOutputError("Knowledge-backed reply omitted its source")
    business_outcome, completion_evidence = context.verify_business_outcome()
    reply = final_output
    if business_outcome == "not_completed":
        error = ":".join(completion_evidence.split(":")[1:]) if completion_evidence else ""
        reply = f"业务操作未完成：{error or 'business_tool_failed'}"
    return AgentRunResult(
        reply=reply,
        knowledge_search_results=list(knowledge_search_results.values()),
        memory_events=list(context.memory_events),
        business_outcome=business_outcome,
        completion_evidence=completion_evidence,
        support_request_id=context.support_request_id,
    )


def persist_agent_run(context: AgentContext, result: AgentRunResult) -> AgentRunResult:
    """成功路径把结果写回 trace（§8.5）；sources 去重排序由 store 层完成。"""
    context.trace_store.record_outcome(
        context.trace_id,
        business_outcome=result.business_outcome,
        completion_evidence=result.completion_evidence,
        knowledge_sources=[record.source for record in result.knowledge_search_results],
        memory_sources=[
            memory.source_id for event in result.memory_events for memory in event.memories
        ],
        support_request_id=result.support_request_id,
    )
    return result


def persist_agent_failure(trace_store: TraceStore, trace_id: str, code: str) -> None:
    """失败路径：error span + trace 置 failed（§8.4）。"""
    trace_store.record_error(trace_id, code=code)
    trace_store.fail(trace_id)


def _handoff_result(
    context: AgentContext,
    *,
    reply: str,
    support_request_id: str,
    knowledge_search_results: Mapping[str, KnowledgeRecord],
) -> AgentRunResult:
    return AgentRunResult(
        reply=reply,
        knowledge_search_results=list(knowledge_search_results.values()),
        memory_events=list(context.memory_events),
        business_outcome="not_completed",
        completion_evidence=f"handoff:{support_request_id}",
        support_request_id=support_request_id,
    )
