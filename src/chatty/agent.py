from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Annotated, Literal

from agents import (
    Agent,
    AsyncOpenAI,
    Model,
    ModelSettings,
    OpenAIChatCompletionsModel,
    RunConfig,
    RunContextWrapper,
    Runner,
    SQLiteSession,
    ToolCallItem,
    function_tool,
)
from agents.exceptions import MaxTurnsExceeded, ModelBehaviorError
from pydantic import Field, StringConstraints

from chatty.knowledge import KnowledgeRecord, KnowledgeStore
from agents.tool import Tool

from chatty.commerce import CommerceStore
from chatty.order_tools import BusinessOutcome, HarnessContext, build_order_tools
from chatty.store import CustomerMemory, MemoryStore, SupportRequestStore, TraceStore

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL_ID = "deepseek-v4-pro"

AGENT_INSTRUCTIONS = """你是 Chatty，一个简洁、可靠的客服 Agent。
直接理解用户消息，由你选择合适的 Tool 查询库存、查看或更改订单。
只有 Tool 返回 ok=true 且 SQLite 状态与请求一致时，才能声称业务操作完成。
信息不足时提出一个聚焦的问题，不要编造事实。
回答政策或商品事实前必须调用 search_knowledge；使用检索内容时必须原样附上至少一个 source。
仅当客户明确要求记住其直接陈述、且该事实跨交易稳定时，调用 save_customer_memory。
临时需求、当前订单偏好、推断或画像不得保存；需要既有客户事实时主动搜索 Memory。
需要人工判断、授权或无法安全完成时，必须调用 create_handoff；
不能只回复“请联系客服”，只有持久化 receipt 才算已交接。
"""


class MissingApiKeyError(RuntimeError):
    pass


class InvalidAgentOutputError(RuntimeError):
    pass


class HandoffPersistenceError(RuntimeError):
    pass


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
    prior_actions: list[str] = field(default_factory=list)
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


def _force_handoff(
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


def memory_tools() -> list[Tool]:
    @function_tool(use_docstring_info=False)
    async def save_customer_memory(
        context: RunContextWrapper[AgentContext],
        fact: Annotated[
            str,
            StringConstraints(strip_whitespace=True, min_length=1, max_length=500),
        ],
        explicitly_stated: Literal[True],
        stable: Literal[True],
    ) -> str:
        fact = fact.strip()
        if not fact:
            raise ValueError("memory fact must not be blank")
        if fact.casefold() not in context.context.message.casefold():
            raise ValueError("memory fact must be a verbatim part of the customer message")
        memory = context.context.memory_store.save(
            customer_id=context.context.customer_id,
            fact=fact,
            source_id=context.context.trace_id,
        )
        event = MemoryEvent(tool="save_customer_memory", memories=[memory])
        context.context.memory_events.append(event)
        return json.dumps(
            {"tool": event.tool, "memories": [asdict(memory)]},
            ensure_ascii=False,
        )

    @function_tool(use_docstring_info=False)
    async def search_customer_memory(
        context: RunContextWrapper[AgentContext],
        query: Annotated[
            str,
            StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
        ],
        limit: Annotated[int, Field(ge=1, le=10)] = 5,
    ) -> str:
        query = query.strip()
        if not query:
            raise ValueError("memory query must not be blank")
        memories = context.context.memory_store.search(
            customer_id=context.context.customer_id,
            query=query,
            limit=limit,
        )
        event = MemoryEvent(tool="search_customer_memory", memories=memories)
        context.context.memory_events.append(event)
        return json.dumps(
            {"tool": event.tool, "memories": [asdict(memory) for memory in memories]},
            ensure_ascii=False,
        )

    return [search_customer_memory, save_customer_memory]


def model_from_env() -> tuple[Model, str]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise MissingApiKeyError("OPENAI_API_KEY is required")
    model_id = os.getenv("MODEL_ID", DEFAULT_MODEL_ID)
    client = AsyncOpenAI(
        api_key=api_key,
        base_url=os.getenv("OPENAI_BASE_URL", DEFAULT_BASE_URL),
    )
    return OpenAIChatCompletionsModel(model=model_id, openai_client=client), model_id


async def run_agent(
    *,
    message: str,
    session_id: str,
    database_path: str | Path,
    model: Model,
    model_id: str,
    trace_id: str,
    request_id: str,
    knowledge_store: KnowledgeStore,
    customer_id: str,
    commerce: CommerceStore,
    support_store: SupportRequestStore,
    trace_store: TraceStore,
) -> AgentRunResult:
    knowledge_search_results: dict[str, KnowledgeRecord] = {}

    @function_tool
    def search_knowledge(
        query: Annotated[str, Field(min_length=1, max_length=500)],
        limit: Annotated[int, Field(ge=1, le=5)] = 3,
    ) -> str:
        """Search seller-verified policy and product knowledge.

        Args:
            query: Model-selected lexical query.
            limit: Maximum number of structured source records to return.
        """
        search_result = knowledge_store.search(query, limit=limit)
        for record in search_result.results:
            knowledge_search_results[record.id] = record
        return search_result.model_dump_json()

    context = AgentContext(
        customer_id=customer_id,
        session_id=session_id,
        commerce=commerce,
        message=message,
        trace_id=trace_id,
        request_id=request_id,
        memory_store=MemoryStore(database_path),
        support_store=support_store,
        trace_store=trace_store,
    )
    context.memory_store.bind_session(session_id=session_id, customer_id=customer_id)
    agent_tools: list[Tool] = [
        search_knowledge,
        *memory_tools(),
        *build_order_tools(),
        create_handoff,
    ]
    agent: Agent[AgentContext] = Agent(
        name="Chatty",
        instructions=AGENT_INSTRUCTIONS,
        model=model,
        model_settings=ModelSettings(extra_body={"thinking": {"type": "disabled"}}),
        tools=agent_tools,
    )
    session = SQLiteSession(
        session_id,
        db_path=database_path,
        sessions_table="chatty_sessions",
        messages_table="chatty_messages",
    )
    try:
        try:
            result = await Runner.run(
                agent,
                message,
                context=context,
                session=session,
                run_config=RunConfig(
                    workflow_name="Chatty Agent Run",
                    trace_id=trace_id,
                    group_id=session_id,
                    trace_metadata={"model_id": model_id},
                    trace_include_sensitive_data=False,
                ),
            )
        except ModelBehaviorError:
            context.prior_actions.append("model_tool_call:rejected")
            return _force_handoff(
                context,
                reason="Harness 拒绝无效操作",
                details="Model 请求了无效或不可用的 Tool",
                knowledge_search_results=knowledge_search_results,
            )
        except MaxTurnsExceeded:
            context.prior_actions.append("agent_loop:max_turns")
            return _force_handoff(
                context,
                reason="Harness 安全恢复已耗尽",
                details="Agent 在受限 turns 内未完成处理",
                knowledge_search_results=knowledge_search_results,
            )
    finally:
        session.close()
    if result.interruptions:
        context.prior_actions.append("tool_permission:approval_required")
        return _force_handoff(
            context,
            reason="Harness 需要人工权限或授权",
            details="Tool 权限边界中断了同步执行",
        )
    if not isinstance(result.final_output, str) or not result.final_output.strip():
        return _force_handoff(
            context,
            reason="Harness 安全恢复已耗尽",
            details="Agent 未返回可验证的客户结果",
            knowledge_search_results=knowledge_search_results,
        )
    attempted_support = any(
        isinstance(item, ToolCallItem) and item.tool_name == "create_handoff"
        for item in result.new_items
    )
    if attempted_support and context.support_request_id is None:
        return _force_handoff(
            context,
            reason="Harness 强制升级",
            details="create_handoff 调用失败或参数无效",
            knowledge_search_results=knowledge_search_results,
        )
    if context.support_request_id is not None:
        return _handoff_result(
            context,
            reply=result.final_output,
            support_request_id=context.support_request_id,
            knowledge_search_results=knowledge_search_results,
        )
    if knowledge_search_results and not any(
        record.source in result.final_output for record in knowledge_search_results.values()
    ):
        raise InvalidAgentOutputError("Knowledge-backed reply omitted its source")
    business_outcome, completion_evidence = context.verify_business_outcome()
    reply = result.final_output
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
