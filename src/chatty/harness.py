from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal

from agents import RunContextWrapper, ToolCallItem, function_tool
from pydantic import ValidationError

from chatty.commerce import CommerceError, CommerceStore, Order
from chatty.knowledge import KnowledgeRecord
from chatty.store import (
    CustomerMemory,
    MemoryStore,
    SupportRequestIdempotencyConflictError,
    SupportRequestStore,
    TraceStore,
)

BusinessOutcome = Literal["verified", "not_completed", "not_applicable"]
MUTATION_TOOLS = frozenset({"create_order", "confirm_order", "cancel_order"})


class InvalidAgentOutputError(RuntimeError):
    pass


class HandoffPersistenceError(RuntimeError):
    pass


class HandoffIdempotencyConflictError(RuntimeError):
    pass


@dataclass(frozen=True)
class BusinessToolReceipt:
    tool_name: str
    ok: bool
    order_id: str | None = None
    expected_status: str | None = None
    evidence: str | None = None
    error: str | None = None


@dataclass
class HarnessContext:
    customer_id: str
    session_id: str
    commerce: CommerceStore
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

    def record_failure(self, tool_name: str, error: Exception) -> None:
        self.prior_actions.append(f"{tool_name}:failed")
        self.business_receipts.append(
            BusinessToolReceipt(tool_name=tool_name, ok=False, error=_error_code(error))
        )

    def verify_business_outcome(self) -> tuple[BusinessOutcome, str | None]:
        if not self.business_receipts:
            return "not_applicable", None
        mutations = [
            receipt for receipt in self.business_receipts if receipt.tool_name in MUTATION_TOOLS
        ]
        latest = mutations[-1] if mutations else self.business_receipts[-1]
        if not latest.ok:
            return "not_completed", f"{latest.tool_name}:{latest.error}"
        if latest.evidence is not None:
            return "verified", latest.evidence
        if latest.order_id is None or latest.expected_status is None:
            raise CommerceError("missing_completion_evidence")
        persisted = self.commerce.get_order(latest.order_id)
        if persisted.status != latest.expected_status:
            raise CommerceError("unverified_business_outcome")
        return "verified", f"{latest.tool_name}:{persisted.id}:{persisted.status}"


@dataclass(frozen=True)
class MemoryEvent:
    tool: str
    memories: list[CustomerMemory]


@dataclass(frozen=True)
class AgentRunResult:
    reply: str
    knowledge_search_results: list[KnowledgeRecord]
    memory_events: list[MemoryEvent]
    business_outcome: BusinessOutcome
    completion_evidence: str | None
    support_request_id: str | None


@dataclass(kw_only=True)
class AgentContext(HarnessContext):
    message: str
    trace_id: str
    request_id: str
    memory_store: MemoryStore
    support_store: SupportRequestStore
    trace_store: TraceStore
    memory_events: list[MemoryEvent] = field(default_factory=list)
    support_request_id: str | None = None


@function_tool
def create_handoff(
    ctx: RunContextWrapper[AgentContext], reason: str, context: str
) -> dict[str, str]:
    """Create a traceable support receipt for human judgment or authorization."""
    try:
        receipt = ctx.context.support_store.create(
            customer_id=ctx.context.customer_id,
            session_id=ctx.context.session_id,
            reason=reason,
            context=ctx.context.message.strip(),
            model_context=context,
            prior_actions=tuple(ctx.context.prior_actions),
            idempotency_key=(
                f"{ctx.context.customer_id}:{ctx.context.session_id}:"
                f"{ctx.context.request_id}:handoff"
            ),
        )
    except SupportRequestIdempotencyConflictError as error:
        ctx.context.prior_actions.append("create_handoff:failed")
        raise HandoffIdempotencyConflictError("handoff_idempotency_conflict") from error
    except Exception as error:
        ctx.context.prior_actions.append("create_handoff:failed")
        ctx.context.trace_store.record_tool_event(
            ctx.context.trace_id,
            status="failed",
            summary="create_handoff failed",
        )
        raise HandoffPersistenceError("handoff receipt could not be persisted") from error
    ctx.context.support_request_id = receipt.id
    ctx.context.trace_store.record_tool_event(
        ctx.context.trace_id,
        status="completed",
        summary="create_handoff created receipt",
    )
    return {"support_request_id": receipt.id, "status": receipt.status}


def force_handoff(
    context: AgentContext,
    *,
    reason: str,
    details: str,
    knowledge_search_results: dict[str, KnowledgeRecord],
) -> AgentRunResult:
    try:
        receipt = context.support_store.create(
            customer_id=context.customer_id,
            session_id=context.session_id,
            reason=reason,
            context=context.message.strip(),
            model_context=details,
            prior_actions=tuple(context.prior_actions),
            idempotency_key=(
                f"{context.customer_id}:{context.session_id}:{context.request_id}:handoff"
            ),
        )
    except SupportRequestIdempotencyConflictError as error:
        raise HandoffIdempotencyConflictError("handoff_idempotency_conflict") from error
    except Exception as error:
        context.trace_store.record_tool_event(
            context.trace_id,
            status="failed",
            summary="Harness-enforced handoff receipt failed",
        )
        raise HandoffPersistenceError("handoff receipt could not be persisted") from error
    context.trace_store.record_tool_event(
        context.trace_id,
        status="completed",
        summary="Harness-enforced handoff receipt created",
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
    interruptions: Sequence[object],
    new_items: Sequence[object],
    knowledge_search_results: dict[str, KnowledgeRecord],
) -> AgentRunResult:
    if interruptions:
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
    attempted_support = any(
        isinstance(item, ToolCallItem) and item.tool_name == "create_handoff" for item in new_items
    )
    if attempted_support and context.support_request_id is None:
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
        error_code = (completion_evidence or "").partition(":")[2] or "business_tool_failed"
        reply = f"业务操作未完成：{error_code}"
    return AgentRunResult(
        reply=reply,
        knowledge_search_results=list(knowledge_search_results.values()),
        memory_events=context.memory_events,
        business_outcome=business_outcome,
        completion_evidence=completion_evidence,
        support_request_id=context.support_request_id,
    )


def persist_agent_run(context: AgentContext, result: AgentRunResult) -> AgentRunResult:
    context.trace_store.record_outcome(
        context.trace_id,
        business_outcome=result.business_outcome,
        completion_evidence=result.completion_evidence,
        knowledge_sources=[item.source for item in result.knowledge_search_results],
        memory_sources=[
            memory.source_id for event in result.memory_events for memory in event.memories
        ],
        support_request_id=result.support_request_id,
    )
    return result


def persist_agent_failure(trace_store: TraceStore, trace_id: str, code: str) -> None:
    trace_store.record_error(trace_id, code=code)
    trace_store.fail(trace_id)


def _handoff_result(
    context: AgentContext,
    *,
    reply: str,
    support_request_id: str,
    knowledge_search_results: dict[str, KnowledgeRecord],
) -> AgentRunResult:
    return AgentRunResult(
        reply=reply,
        knowledge_search_results=list(knowledge_search_results.values()),
        memory_events=context.memory_events,
        business_outcome="not_completed",
        completion_evidence=f"handoff:{support_request_id}",
        support_request_id=support_request_id,
    )


def _error_code(error: Exception) -> str:
    if isinstance(error, ValidationError):
        return "invalid_tool_input"
    return str(error)
