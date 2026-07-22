"""Chatty 的 12 个 function tools 与统一执行入口。

双层校验（specs/harness-tools.md §4.2）：
- SDK 层：openai-agents 按 strict schema 校验模型参数；失败走 failure_error_function
  （记失败回执 + 把错误 JSON 返回给模型，run 不中断）。
- Harness 层：execute_chatty_tool 用同一 schema 对原始参数二次校验；eval compose lane
  绕过 SDK 直接调用本入口，行为必须与 SDK 路径完全一致。

身份（customer_id/session_id/trace_id/request_id）全部来自 AgentContext 服务端注入，
绝不出现在任何 tool 的参数 schema 中（§4.3）。
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal

from agents import RunContextWrapper, function_tool
from agents.tool import Tool
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from chatty.commerce import CommerceError, CreateOrderInput, FulfillmentMode
from chatty.contracts import CustomerMemory, KnowledgeRecord, MemoryEvent, Order
from chatty.harness import AgentContext, create_handoff_receipt
from chatty.knowledge import KnowledgeStore
from chatty.memory import CustomerMemory as StoredCustomerMemory

IsoDateString = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")]

# description 逐字保留（§5）。
TOOL_DESCRIPTIONS: dict[str, str] = {
    "search_knowledge": "Search seller-verified policy and product knowledge.",
    "search_customer_memory": "Search explicit stable facts for the trusted customer.",
    "save_customer_memory": "Save one verbatim, explicit, stable customer fact.",
    "check_availability": "Check real SQLite inventory for a rental period or buyout.",
    "create_order": "Create one pending order using trusted customer and session identity.",
    "view_order": "Read one order belonging to the trusted customer.",
    "confirm_order": "Confirm a trusted customer's order and allocate inventory once.",
    "cancel_order": "Cancel a trusted customer's order and release inventory once.",
    "create_handoff": "Create a traceable support receipt for human judgment or authorization.",
    "save_research_artifact": (
        "Persist and automatically review one grounded research artifact. Every source_ids "
        "value must be the id field returned by search_knowledge, not its source URL. A "
        "passing review leaves the artifact review_pending for trusted-user approval."
    ),
    "save_content_artifact": (
        "Persist and review a channel content artifact grounded in one reviewed research "
        "artifact."
    ),
    "export_artifact": (
        "When the user explicitly asks to export an artifact, call this tool and let the "
        "Harness verify its current trusted-user approval from SQLite; do not rely on stale "
        "conversation state. Never call it while creating a draft or merely because automatic "
        "review passed."
    ),
}


@dataclass
class ToolExecutionState:
    """单次 run 的 tool 执行状态（§1 步骤 5）：每次 run 全新、内存态、不落库。"""

    knowledge_search_results: dict[str, KnowledgeRecord] = field(default_factory=dict)


class _StrictModel(BaseModel):
    """所有 tool 参数对象 strict：等价 zod .strict() / additionalProperties: false。"""

    model_config = ConfigDict(extra="forbid")


class SearchKnowledgeParams(_StrictModel):
    query: str = Field(min_length=1, max_length=500)
    limit: int = Field(default=3, ge=1, le=5)


class SearchCustomerMemoryParams(_StrictModel):
    query: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    limit: int = Field(default=5, ge=1, le=10)


class SaveCustomerMemoryParams(_StrictModel):
    fact: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    explicitly_stated: Literal[True]
    stable: Literal[True]


class CheckAvailabilityParams(_StrictModel):
    product_id: str
    size: str
    fulfillment_mode: FulfillmentMode
    quantity: int
    start_date: IsoDateString | None
    end_date: IsoDateString | None


class CreateOrderParams(_StrictModel):
    idempotency_key: str = Field(min_length=1, max_length=200)
    product_id: str = Field(min_length=1, max_length=100)
    size: str = Field(min_length=1, max_length=40)
    fulfillment_mode: FulfillmentMode
    quantity: int = Field(ge=1, le=100)
    start_date: IsoDateString | None
    end_date: IsoDateString | None
    amount_cents: int = Field(gt=0)
    channel: str = Field(default="Chatty", min_length=1, max_length=100)
    address: str = Field(min_length=1, max_length=500)
    risk: str = Field(min_length=1, max_length=500)


class OrderIdParams(_StrictModel):
    order_id: str


class CreateHandoffParams(_StrictModel):
    reason: str
    context: str


class ResearchClaimParams(_StrictModel):
    id: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=1, max_length=2000)
    source_ids: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(
        min_length=1, max_length=10
    )


class ResearchNodeParams(_StrictModel):
    id: str = Field(min_length=1, max_length=100)
    label: str = Field(min_length=1, max_length=200)
    kind: str = Field(min_length=1, max_length=100)


class ResearchRelationParams(_StrictModel):
    """`from` 是 Python 保留字：字段名 from_，schema/序列化/输入都只按别名 from。"""

    model_config = ConfigDict(extra="forbid", serialize_by_alias=True)

    from_: str = Field(alias="from", min_length=1, max_length=100)
    to: str = Field(min_length=1, max_length=100)
    type: str = Field(min_length=1, max_length=100)
    claim_id: str = Field(min_length=1, max_length=100)


class SaveResearchArtifactParams(_StrictModel):
    idempotency_key: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=500)
    summary: str = Field(min_length=1, max_length=2000)
    claims: list[ResearchClaimParams] = Field(min_length=1, max_length=30)
    nodes: list[ResearchNodeParams] = Field(max_length=30)
    relations: list[ResearchRelationParams] = Field(max_length=60)
    unknowns: list[Annotated[str, Field(min_length=1, max_length=500)]] = Field(max_length=20)


class ContentChannelParams(_StrictModel):
    channel: Literal["xiaohongshu", "douyin", "wechat"]
    title: str = Field(min_length=1, max_length=500)
    body: str = Field(min_length=1, max_length=10000)
    claim_ids: list[Annotated[str, Field(min_length=1, max_length=100)]] = Field(
        min_length=1, max_length=30
    )


class SaveContentArtifactParams(_StrictModel):
    idempotency_key: str = Field(min_length=1, max_length=200)
    research_artifact_id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=500)
    channels: list[ContentChannelParams] = Field(min_length=1, max_length=3)


class ExportArtifactParams(_StrictModel):
    artifact_id: str = Field(min_length=1, max_length=200)
    target: Literal["sandbox"]


def _success_json(**payload: Any) -> str:
    return json.dumps({"ok": True, **payload}, ensure_ascii=False)


def _failure_json(error: Exception) -> str:
    return json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False)


def _memory_model(memory: StoredCustomerMemory) -> CustomerMemory:
    return CustomerMemory(
        memory_id=memory.memory_id,
        customer_id=memory.customer_id,
        fact=memory.fact,
        source_id=memory.source_id,
        created_at=memory.created_at,
    )


def _customer_order(context: AgentContext, order_id: str) -> Order:
    """订单归属检查（§4.3）：不泄露他人订单存在性。"""
    order = context.commerce.get_order(order_id)
    if order.customer_id != context.customer_id:
        raise CommerceError("order_not_found")
    return order


def _search_knowledge(
    context: AgentContext,
    state: ToolExecutionState,
    knowledge_store: KnowledgeStore,
    params: SearchKnowledgeParams,
) -> str:
    result = knowledge_store.search(params.query, limit=params.limit)
    context.prior_actions.append(f"search_knowledge:{result.status}")
    for record in result.results:
        state.knowledge_search_results[record.id] = record
    return result.model_dump_json()


def _search_customer_memory(
    context: AgentContext,
    state: ToolExecutionState,
    knowledge_store: KnowledgeStore,
    params: SearchCustomerMemoryParams,
) -> str:
    memories = context.memory_store.search(
        customer_id=context.customer_id, query=params.query, limit=params.limit
    )
    event = MemoryEvent(
        tool="search_customer_memory",
        memories=[_memory_model(memory) for memory in memories],
    )
    context.memory_events.append(event)
    context.prior_actions.append("search_customer_memory:ok")
    return event.model_dump_json()


def _save_customer_memory(
    context: AgentContext,
    state: ToolExecutionState,
    knowledge_store: KnowledgeStore,
    params: SaveCustomerMemoryParams,
) -> str:
    # 逐字子串不变量（§6.1）：message 用原文（不 trim），fact 是 trim 后的值；
    # casefold 语义直接用解释器原生 str.casefold()（decisions §4.4）。
    if params.fact.casefold() not in context.message.casefold():
        raise ValueError("memory fact must be a verbatim part of the customer message")
    saved = context.memory_store.save(
        customer_id=context.customer_id, fact=params.fact, source_id=context.trace_id
    )
    event = MemoryEvent(tool="save_customer_memory", memories=[_memory_model(saved)])
    context.memory_events.append(event)
    context.prior_actions.append("save_customer_memory:ok")
    return event.model_dump_json()


def _check_availability(
    context: AgentContext,
    state: ToolExecutionState,
    knowledge_store: KnowledgeStore,
    params: CheckAvailabilityParams,
) -> str:
    availability = context.commerce.check_availability(
        product_id=params.product_id,
        size=params.size,
        quantity=params.quantity,
        fulfillment_mode=params.fulfillment_mode,
        start_date=params.start_date,
        end_date=params.end_date,
    )
    context.record_read_success(
        "check_availability",
        (
            f"check_availability:{availability.product_id}:{availability.size}:"
            f"available={availability.available_quantity}"
        ),
    )
    return _success_json(availability=availability.model_dump(mode="json"))


def _create_order(
    context: AgentContext,
    state: ToolExecutionState,
    knowledge_store: KnowledgeStore,
    params: CreateOrderParams,
) -> str:
    order_input = CreateOrderInput(
        idempotency_key=f"{context.session_id}:{params.idempotency_key}",
        customer_id=context.customer_id,
        session_id=context.session_id,
        product_id=params.product_id,
        size=params.size,
        fulfillment_mode=params.fulfillment_mode,
        quantity=params.quantity,
        start_date=params.start_date,
        end_date=params.end_date,
        amount_cents=params.amount_cents,
        channel=params.channel,
        address=params.address,
        risk=params.risk,
    )
    order = context.commerce.create_order(order_input)
    context.record_order_success("create_order", order)
    return _success_json(order=order.model_dump(mode="json"))


def _view_order(
    context: AgentContext,
    state: ToolExecutionState,
    knowledge_store: KnowledgeStore,
    params: OrderIdParams,
) -> str:
    order = _customer_order(context, params.order_id)
    context.record_read_success("view_order", f"view_order:{order.id}:{order.status}")
    return _success_json(order=order.model_dump(mode="json"))


def _confirm_order(
    context: AgentContext,
    state: ToolExecutionState,
    knowledge_store: KnowledgeStore,
    params: OrderIdParams,
) -> str:
    _customer_order(context, params.order_id)
    order = context.commerce.confirm_order(params.order_id)
    context.record_order_success("confirm_order", order)
    return _success_json(order=order.model_dump(mode="json"))


def _cancel_order(
    context: AgentContext,
    state: ToolExecutionState,
    knowledge_store: KnowledgeStore,
    params: OrderIdParams,
) -> str:
    _customer_order(context, params.order_id)
    order = context.commerce.cancel_order(params.order_id)
    context.record_order_success("cancel_order", order)
    return _success_json(order=order.model_dump(mode="json"))


def _create_handoff(
    context: AgentContext,
    state: ToolExecutionState,
    knowledge_store: KnowledgeStore,
    params: CreateHandoffParams,
) -> str:
    receipt = create_handoff_receipt(context, reason=params.reason, model_context=params.context)
    return json.dumps(receipt, ensure_ascii=False)


def _save_research_artifact(
    context: AgentContext,
    state: ToolExecutionState,
    knowledge_store: KnowledgeStore,
    params: SaveResearchArtifactParams,
) -> str:
    # source 溯源不变量（§6.2）：run 级内存态，首个违规即抛。
    for claim in params.claims:
        for source_id in claim.source_ids:
            if source_id not in state.knowledge_search_results:
                raise RuntimeError(f"artifact_source_not_searched:{source_id}")
    artifact = context.artifacts.create_research(
        idempotency_key=f"{context.session_id}:{params.idempotency_key}",
        owner_id=context.customer_id,
        session_id=context.session_id,
        title=params.title,
        summary=params.summary,
        claims=list(params.claims),
        nodes=list(params.nodes),
        relations=list(params.relations),
        unknowns=list(params.unknowns),
    )
    review = context.artifacts.review(artifact.id)
    reviewed = context.artifacts.get(artifact.id)
    if not review.passed:
        raise RuntimeError("artifact_review_failed:" + ",".join(review.errors))
    context.record_artifact_success("save_research_artifact", reviewed.id, reviewed.status)
    return _success_json(
        artifact=reviewed.model_dump(mode="json"), review=review.model_dump(mode="json")
    )


def _save_content_artifact(
    context: AgentContext,
    state: ToolExecutionState,
    knowledge_store: KnowledgeStore,
    params: SaveContentArtifactParams,
) -> str:
    artifact = context.artifacts.create_content(
        idempotency_key=f"{context.session_id}:{params.idempotency_key}",
        owner_id=context.customer_id,
        session_id=context.session_id,
        research_artifact_id=params.research_artifact_id,
        title=params.title,
        channels=list(params.channels),
    )
    review = context.artifacts.review(artifact.id)
    reviewed = context.artifacts.get(artifact.id)
    if not review.passed:
        raise RuntimeError("artifact_review_failed:" + ",".join(review.errors))
    context.record_artifact_success("save_content_artifact", reviewed.id, reviewed.status)
    return _success_json(
        artifact=reviewed.model_dump(mode="json"), review=review.model_dump(mode="json")
    )


def _export_artifact(
    context: AgentContext,
    state: ToolExecutionState,
    knowledge_store: KnowledgeStore,
    params: ExportArtifactParams,
) -> str:
    delivery = context.artifacts.export(params.artifact_id, params.target, context.customer_id)
    context.record_delivery_success("export_artifact", delivery.id, delivery.content_hash)
    return _success_json(delivery=delivery.model_dump(mode="json"))


_ToolHandler = Callable[[AgentContext, ToolExecutionState, KnowledgeStore, Any], str]


@dataclass(frozen=True)
class _ToolSpec:
    params_model: type[_StrictModel]
    handler: _ToolHandler


_TOOL_SPECS: dict[str, _ToolSpec] = {
    "search_knowledge": _ToolSpec(SearchKnowledgeParams, _search_knowledge),
    "search_customer_memory": _ToolSpec(SearchCustomerMemoryParams, _search_customer_memory),
    "save_customer_memory": _ToolSpec(SaveCustomerMemoryParams, _save_customer_memory),
    "check_availability": _ToolSpec(CheckAvailabilityParams, _check_availability),
    "create_order": _ToolSpec(CreateOrderParams, _create_order),
    "view_order": _ToolSpec(OrderIdParams, _view_order),
    "confirm_order": _ToolSpec(OrderIdParams, _confirm_order),
    "cancel_order": _ToolSpec(OrderIdParams, _cancel_order),
    "create_handoff": _ToolSpec(CreateHandoffParams, _create_handoff),
    "save_research_artifact": _ToolSpec(SaveResearchArtifactParams, _save_research_artifact),
    "save_content_artifact": _ToolSpec(SaveContentArtifactParams, _save_content_artifact),
    "export_artifact": _ToolSpec(ExportArtifactParams, _export_artifact),
}

CHATTY_TOOL_NAMES: tuple[str, ...] = tuple(_TOOL_SPECS)


def execute_chatty_tool(
    *,
    context: AgentContext,
    state: ToolExecutionState,
    knowledge_store: KnowledgeStore,
    tool_name: str,
    arguments: str | Mapping[str, Any],
) -> str:
    """12 个 tool 的统一执行入口（§4.2 Harness 层校验）。

    参数校验失败或 tool 体内异常都不中断 run：记一条失败回执（干净语义，
    decisions §2.3）并把 `{"ok": false, "error": ...}` 返回给模型。
    """
    spec = _TOOL_SPECS.get(tool_name)
    if spec is None:
        raise ValueError(f"unknown_tool:{tool_name}")
    try:
        if isinstance(arguments, str):
            params = spec.params_model.model_validate_json(arguments)
        else:
            params = spec.params_model.model_validate(dict(arguments))
    except ValidationError as error:
        context.record_failure(tool_name, error)
        return _failure_json(error)
    try:
        return spec.handler(context, state, knowledge_store, params)
    except Exception as error:
        context.record_failure(tool_name, error)
        return _failure_json(error)


def build_chatty_tools(
    *, state: ToolExecutionState, knowledge_store: KnowledgeStore
) -> list[Tool]:
    """构造 12 个 strict function tools（§4.1/§5）。

    每个 tool 的 SDK 签名只负责 strict schema 与默认值声明；执行时取原始参数
    JSON（ToolContext.tool_arguments）走 execute_chatty_tool 二次校验后执行——
    与 eval compose lane 的直调路径完全一致。
    """

    def dispatch(ctx: RunContextWrapper[AgentContext], tool_name: str) -> str:
        return execute_chatty_tool(
            context=ctx.context,
            state=state,
            knowledge_store=knowledge_store,
            tool_name=tool_name,
            arguments=getattr(ctx, "tool_arguments", "{}"),
        )

    def record_tool_failure(ctx: RunContextWrapper[AgentContext], error: Exception) -> str:
        # SDK 层 strict schema 校验失败（ModelBehaviorError）走这里：
        # 记失败回执（回执码 invalid_tool_input，decisions §2.4）并把错误返回给模型。
        tool_name = getattr(ctx, "tool_name", "unknown_tool")
        ctx.context.record_failure(tool_name, error)
        return _failure_json(error)

    @function_tool(
        description_override=TOOL_DESCRIPTIONS["search_knowledge"],
        use_docstring_info=False,
        failure_error_function=record_tool_failure,
    )
    async def search_knowledge(
        ctx: RunContextWrapper[AgentContext],
        query: Annotated[str, Field(min_length=1, max_length=500)],
        limit: Annotated[int, Field(ge=1, le=5)] = 3,
    ) -> str:
        return dispatch(ctx, "search_knowledge")

    @function_tool(
        description_override=TOOL_DESCRIPTIONS["search_customer_memory"],
        use_docstring_info=False,
        failure_error_function=record_tool_failure,
    )
    async def search_customer_memory(
        ctx: RunContextWrapper[AgentContext],
        query: Annotated[
            str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
        ],
        limit: Annotated[int, Field(ge=1, le=10)] = 5,
    ) -> str:
        return dispatch(ctx, "search_customer_memory")

    @function_tool(
        description_override=TOOL_DESCRIPTIONS["save_customer_memory"],
        use_docstring_info=False,
        failure_error_function=record_tool_failure,
    )
    async def save_customer_memory(
        ctx: RunContextWrapper[AgentContext],
        fact: Annotated[
            str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
        ],
        explicitly_stated: Literal[True],
        stable: Literal[True],
    ) -> str:
        return dispatch(ctx, "save_customer_memory")

    @function_tool(
        description_override=TOOL_DESCRIPTIONS["check_availability"],
        use_docstring_info=False,
        failure_error_function=record_tool_failure,
    )
    async def check_availability(
        ctx: RunContextWrapper[AgentContext],
        product_id: str,
        size: str,
        fulfillment_mode: FulfillmentMode,
        quantity: int,
        start_date: IsoDateString | None,
        end_date: IsoDateString | None,
    ) -> str:
        return dispatch(ctx, "check_availability")

    @function_tool(
        description_override=TOOL_DESCRIPTIONS["create_order"],
        use_docstring_info=False,
        failure_error_function=record_tool_failure,
    )
    async def create_order(
        ctx: RunContextWrapper[AgentContext],
        idempotency_key: Annotated[str, Field(min_length=1, max_length=200)],
        product_id: Annotated[str, Field(min_length=1, max_length=100)],
        size: Annotated[str, Field(min_length=1, max_length=40)],
        fulfillment_mode: FulfillmentMode,
        quantity: Annotated[int, Field(ge=1, le=100)],
        start_date: IsoDateString | None,
        end_date: IsoDateString | None,
        amount_cents: Annotated[int, Field(gt=0)],
        address: Annotated[str, Field(min_length=1, max_length=500)],
        risk: Annotated[str, Field(min_length=1, max_length=500)],
        channel: Annotated[str, Field(min_length=1, max_length=100)] = "Chatty",
    ) -> str:
        return dispatch(ctx, "create_order")

    @function_tool(
        description_override=TOOL_DESCRIPTIONS["view_order"],
        use_docstring_info=False,
        failure_error_function=record_tool_failure,
    )
    async def view_order(ctx: RunContextWrapper[AgentContext], order_id: str) -> str:
        return dispatch(ctx, "view_order")

    @function_tool(
        description_override=TOOL_DESCRIPTIONS["confirm_order"],
        use_docstring_info=False,
        failure_error_function=record_tool_failure,
    )
    async def confirm_order(ctx: RunContextWrapper[AgentContext], order_id: str) -> str:
        return dispatch(ctx, "confirm_order")

    @function_tool(
        description_override=TOOL_DESCRIPTIONS["cancel_order"],
        use_docstring_info=False,
        failure_error_function=record_tool_failure,
    )
    async def cancel_order(ctx: RunContextWrapper[AgentContext], order_id: str) -> str:
        return dispatch(ctx, "cancel_order")

    @function_tool(
        description_override=TOOL_DESCRIPTIONS["create_handoff"],
        use_docstring_info=False,
        failure_error_function=record_tool_failure,
    )
    async def create_handoff(
        ctx: RunContextWrapper[AgentContext], reason: str, context: str
    ) -> str:
        return dispatch(ctx, "create_handoff")

    @function_tool(
        description_override=TOOL_DESCRIPTIONS["save_research_artifact"],
        use_docstring_info=False,
        failure_error_function=record_tool_failure,
    )
    async def save_research_artifact(
        ctx: RunContextWrapper[AgentContext],
        idempotency_key: Annotated[str, Field(min_length=1, max_length=200)],
        title: Annotated[str, Field(min_length=1, max_length=500)],
        summary: Annotated[str, Field(min_length=1, max_length=2000)],
        claims: Annotated[list[ResearchClaimParams], Field(min_length=1, max_length=30)],
        nodes: Annotated[list[ResearchNodeParams], Field(max_length=30)],
        relations: Annotated[list[ResearchRelationParams], Field(max_length=60)],
        unknowns: Annotated[
            list[Annotated[str, Field(min_length=1, max_length=500)]], Field(max_length=20)
        ],
    ) -> str:
        return dispatch(ctx, "save_research_artifact")

    @function_tool(
        description_override=TOOL_DESCRIPTIONS["save_content_artifact"],
        use_docstring_info=False,
        failure_error_function=record_tool_failure,
    )
    async def save_content_artifact(
        ctx: RunContextWrapper[AgentContext],
        idempotency_key: Annotated[str, Field(min_length=1, max_length=200)],
        research_artifact_id: Annotated[str, Field(min_length=1, max_length=200)],
        title: Annotated[str, Field(min_length=1, max_length=500)],
        channels: Annotated[list[ContentChannelParams], Field(min_length=1, max_length=3)],
    ) -> str:
        return dispatch(ctx, "save_content_artifact")

    @function_tool(
        description_override=TOOL_DESCRIPTIONS["export_artifact"],
        use_docstring_info=False,
        failure_error_function=record_tool_failure,
    )
    async def export_artifact(
        ctx: RunContextWrapper[AgentContext],
        artifact_id: Annotated[str, Field(min_length=1, max_length=200)],
        target: Literal["sandbox"],
    ) -> str:
        return dispatch(ctx, "export_artifact")

    return [
        search_knowledge,
        search_customer_memory,
        save_customer_memory,
        check_availability,
        create_order,
        view_order,
        confirm_order,
        cancel_order,
        create_handoff,
        save_research_artifact,
        save_content_artifact,
        export_artifact,
    ]
