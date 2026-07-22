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

import inspect
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from agents import RunContextWrapper, function_tool
from agents.tool import Tool
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from chatty.commerce import CommerceError, CreateOrderInput, FulfillmentMode
from chatty.contracts import CustomerMemory, MemoryEvent, Order
from chatty.harness import AgentContext, create_handoff_receipt
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


@dataclass(frozen=True)
class ToolOutcome:
    """tool 体的返回：payload 给模型，status 是 dispatcher 记进 prior_actions 的结果词。

    tool 体不碰 `prior_actions`，只声明本次调用的结果；`{tool}:{status}` 由
    `execute_chatty_tool` 追加，每次调用恰好一条。

    `status=None` 表示本次调用不记——只有 `create_handoff` 如此：它的 support receipt
    已经把整份 prior_actions 快照进去了，再追加一条等于把 handoff 记进 handoff 自己。
    """

    payload: str
    status: str | None = "ok"

    @classmethod
    def ok(cls, **payload: Any) -> ToolOutcome:
        """`{"ok": true, ...}` 形状的成功返回。"""
        return cls(json.dumps({"ok": True, **payload}, ensure_ascii=False))


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


def _search_knowledge(context: AgentContext, params: SearchKnowledgeParams) -> ToolOutcome:
    result = context.knowledge.search(params.query, limit=params.limit)
    for record in result.results:
        context.knowledge_search_results[record.id] = record
    # 检索不可用不是异常：status 原样进 prior_actions（`search_knowledge:error`）。
    return ToolOutcome(result.model_dump_json(), status=result.status)


def _search_customer_memory(
    context: AgentContext, params: SearchCustomerMemoryParams
) -> ToolOutcome:
    memories = context.memory_store.search(
        customer_id=context.customer_id, query=params.query, limit=params.limit
    )
    event = MemoryEvent(
        tool="search_customer_memory",
        memories=[_memory_model(memory) for memory in memories],
    )
    context.memory_events.append(event)
    return ToolOutcome(event.model_dump_json())


def _save_customer_memory(context: AgentContext, params: SaveCustomerMemoryParams) -> ToolOutcome:
    # 逐字子串不变量（§6.1）：message 用原文（不 trim），fact 是 trim 后的值；
    # casefold 语义直接用解释器原生 str.casefold()（decisions §4.4）。
    if params.fact.casefold() not in context.message.casefold():
        raise ValueError("memory fact must be a verbatim part of the customer message")
    saved = context.memory_store.save(
        customer_id=context.customer_id, fact=params.fact, source_id=context.trace_id
    )
    event = MemoryEvent(tool="save_customer_memory", memories=[_memory_model(saved)])
    context.memory_events.append(event)
    return ToolOutcome(event.model_dump_json())


def _check_availability(context: AgentContext, params: CheckAvailabilityParams) -> ToolOutcome:
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
    return ToolOutcome.ok(availability=availability.model_dump(mode="json"))


def _create_order(context: AgentContext, params: CreateOrderParams) -> ToolOutcome:
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
    return ToolOutcome.ok(order=order.model_dump(mode="json"))


def _view_order(context: AgentContext, params: OrderIdParams) -> ToolOutcome:
    order = _customer_order(context, params.order_id)
    context.record_read_success("view_order", f"view_order:{order.id}:{order.status}")
    return ToolOutcome.ok(order=order.model_dump(mode="json"))


def _confirm_order(context: AgentContext, params: OrderIdParams) -> ToolOutcome:
    _customer_order(context, params.order_id)
    order = context.commerce.confirm_order(params.order_id)
    context.record_order_success("confirm_order", order)
    return ToolOutcome.ok(order=order.model_dump(mode="json"))


def _cancel_order(context: AgentContext, params: OrderIdParams) -> ToolOutcome:
    _customer_order(context, params.order_id)
    order = context.commerce.cancel_order(params.order_id)
    context.record_order_success("cancel_order", order)
    return ToolOutcome.ok(order=order.model_dump(mode="json"))


def _create_handoff(context: AgentContext, params: CreateHandoffParams) -> ToolOutcome:
    receipt = create_handoff_receipt(context, reason=params.reason, model_context=params.context)
    # status=None：receipt 里已存了这次 run 到此为止的整份 prior_actions。
    return ToolOutcome(json.dumps(receipt, ensure_ascii=False), status=None)


def _save_research_artifact(
    context: AgentContext, params: SaveResearchArtifactParams
) -> ToolOutcome:
    # source 溯源不变量（ADR 0015 / §6.2）：每个 source_id 必须是本次 run 检索过的
    # 知识 id。判据与它自己那条回执现在落在同一个 context 上，首个违规即抛。
    for claim in params.claims:
        for source_id in claim.source_ids:
            if source_id not in context.knowledge_search_results:
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
    return ToolOutcome.ok(
        artifact=reviewed.model_dump(mode="json"), review=review.model_dump(mode="json")
    )


def _save_content_artifact(context: AgentContext, params: SaveContentArtifactParams) -> ToolOutcome:
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
    return ToolOutcome.ok(
        artifact=reviewed.model_dump(mode="json"), review=review.model_dump(mode="json")
    )


def _export_artifact(context: AgentContext, params: ExportArtifactParams) -> ToolOutcome:
    delivery = context.artifacts.export(params.artifact_id, params.target, context.customer_id)
    context.record_delivery_success("export_artifact", delivery.id, delivery.content_hash)
    return ToolOutcome.ok(delivery=delivery.model_dump(mode="json"))


_ToolHandler = Callable[[AgentContext, Any], ToolOutcome]


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


def _append_prior_action(context: AgentContext, tool_name: str, status: str | None) -> None:
    """`prior_actions` 在 tool 侧的唯一追加点：一次 tool 调用恰好一条。

    追加点只此一处，新增第 13 个 tool 无需知道任何关于这个列表的约定：tool 体只
    返回 `ToolOutcome`，成功、失败、`status=None` 的记录规则全在 dispatcher 手里。
    """
    if status is not None:
        context.prior_actions.append(f"{tool_name}:{status}")


def record_tool_failure(context: AgentContext, tool_name: str, error: Exception) -> str:
    """tool 调用失败的唯一出口：一条 `{tool}:failed` + 一条失败回执 + 错误 JSON。

    SDK 层 strict schema 校验失败（走 failure_error_function，不进 dispatcher）与
    Harness 层校验/执行异常共用本函数，两条路径的失败语义因此不可能分叉。
    """
    _append_prior_action(context, tool_name, "failed")
    context.record_failure(tool_name, error)
    return _failure_json(error)


def execute_chatty_tool(
    *,
    context: AgentContext,
    tool_name: str,
    arguments: str | Mapping[str, Any],
) -> str:
    """12 个 tool 的统一执行入口（§4.2 Harness 层校验）。

    参数校验失败或 tool 体内异常都不中断 run：记一条失败回执（干净语义，
    decisions §2.3）并把 `{"ok": false, "error": ...}` 返回给模型。

    成功与失败都在这里收口，所以 `prior_actions` 也在这里收口：tool 体与
    `record_*` 回执助手都不再触碰这个列表。
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
        return record_tool_failure(context, tool_name, error)
    try:
        outcome = spec.handler(context, params)
    except Exception as error:
        return record_tool_failure(context, tool_name, error)
    _append_prior_action(context, tool_name, outcome.status)
    return outcome.payload


def _params_signature(
    params_model: type[_StrictModel],
) -> tuple[inspect.Signature, dict[str, Any]]:
    """把 params model 的字段翻译成 SDK 需要的函数签名——schema 只声明一次。

    openai-agents 的 function_schema 从函数签名反推参数 model：它读取
    `inspect.signature` 与 `__annotations__`，并从 `Annotated[...]` 元数据里取
    FieldInfo。所以把 params model 每个字段的 FieldInfo 原样挂回 Annotated，
    SDK 侧 strict schema 就由 Harness 侧 params model 派生，二者不可能漂移。

    两点刻意的处理：
    - 默认值只留在 FieldInfo 里，签名参数一律无默认值。否则「有默认值的参数
      后面不能跟无默认值参数」会强迫签名重排字段顺序（`CreateOrderParams.channel`
      即是此例），重排即是第二份声明。
    - 顶层字段不允许 alias：签名参数名就是模型对外的键名，alias 会让二者分叉。
      别名只在嵌套 model 内使用（`ResearchRelationParams.from`），那部分 schema
      由 pydantic 直接生成，不经过签名。
    """
    context_annotation = RunContextWrapper[AgentContext]
    parameters = [
        inspect.Parameter(
            "ctx", inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=context_annotation
        )
    ]
    annotations: dict[str, Any] = {"ctx": context_annotation, "return": str}
    for field_name, field_info in params_model.model_fields.items():
        if field_info.alias is not None:
            raise ValueError(f"top-level tool param must not use an alias: {field_name}")
        annotation = Annotated[field_info.annotation, field_info]
        parameters.append(
            inspect.Parameter(
                field_name, inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=annotation
            )
        )
        annotations[field_name] = annotation
    return inspect.Signature(parameters, return_annotation=str), annotations


def build_chatty_tools() -> list[Tool]:
    """构造 12 个 strict function tools（§4.1/§5）。

    每个 tool 的 SDK 签名只负责 strict schema 与默认值声明；执行时取原始参数
    JSON（ToolContext.tool_arguments）走 execute_chatty_tool 二次校验后执行——
    与 eval compose lane 的直调路径完全一致。

    构造不吃任何 run 级状态：知识库与本次 run 的检索结果都挂在 AgentContext 上，
    经 SDK 的 RunContextWrapper 送达，因此这 12 个 tool 可以一次构造、跨 run 复用。
    """

    def dispatch(ctx: RunContextWrapper[AgentContext], tool_name: str) -> str:
        return execute_chatty_tool(
            context=ctx.context,
            tool_name=tool_name,
            arguments=getattr(ctx, "tool_arguments", "{}"),
        )

    def on_sdk_validation_failure(ctx: RunContextWrapper[AgentContext], error: Exception) -> str:
        # SDK 层 strict schema 校验失败（ModelBehaviorError）走这里：
        # 记失败回执（回执码 invalid_tool_input，decisions §2.4）并把错误返回给模型。
        return record_tool_failure(ctx.context, getattr(ctx, "tool_name", "unknown_tool"), error)

    def build(tool_name: str, spec: _ToolSpec) -> Tool:
        signature, annotations = _params_signature(spec.params_model)

        async def invoke(ctx: RunContextWrapper[AgentContext], *_values: Any) -> str:
            # 参数值由 SDK 校验后按签名位置传入，这里刻意不用：执行统一走
            # execute_chatty_tool 重读原始 JSON，与 eval compose lane 同一条路径。
            return dispatch(ctx, tool_name)

        invoke.__name__ = tool_name
        invoke.__signature__ = signature  # type: ignore[attr-defined]  # ty: ignore[unresolved-attribute]
        invoke.__annotations__ = annotations
        return function_tool(
            invoke,
            name_override=tool_name,
            description_override=TOOL_DESCRIPTIONS[tool_name],
            use_docstring_info=False,
            failure_error_function=on_sdk_validation_failure,
        )

    return [build(tool_name, spec) for tool_name, spec in _TOOL_SPECS.items()]
