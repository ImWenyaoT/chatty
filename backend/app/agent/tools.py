"""主 Agent 可调用的知识检索与营销策略 Tool。

`@function_tool` 会把普通 Python 函数包装成 Model 可见的 Tool Schema。Model 只能看到
函数名、参数和 docstring，真正的 Catalog 与 Evidence 通过 ChattyRunContext 注入，
因此 Model 不能替换数据库，也不能直接修改 Harness Evidence。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Annotated, Literal

from agents import RunContextWrapper, function_tool
from pydantic import Field, TypeAdapter

from app.agent.evidence import (
    RecommendationEvidence,
    guard_repeated_call,
    record_knowledge,
)
from app.agent.workflow import GateDecision, WorkflowStage, stage_guardrail
from app.data.catalog import Catalog
from app.data.models import KnowledgeHit, RecommendationRequest


@dataclass
class ChattyRunContext:
    """一次 Agent Loop 内 Tool 共享的对象，不会写入用户会话。"""

    # 纯知识问答没有商品请求，因此 request 可以是 None。
    request: RecommendationRequest | None
    # catalog 是 SQLite 查询入口；Tool 不直接写 SQL。
    catalog: Catalog
    # evidence 是 Harness 账本，只能由确定性 Tool 代码更新。
    evidence: RecommendationEvidence
    # 下面两个字段由 workflow Hook 为“当前这批 Tool 调用”临时写入。
    batch_stage: WorkflowStage | None = None
    batch_decisions: dict[str, GateDecision] = field(default_factory=dict)


# TypeAdapter 给 `list[KnowledgeHit]` 增加 Pydantic 的运行时 JSON 序列化能力。
KNOWLEDGE_HITS_ADAPTER = TypeAdapter(list[KnowledgeHit])


@function_tool(
    name_override="retrieve_knowledge",
    failure_error_function=None,
    tool_input_guardrails=[stage_guardrail],
)
async def retrieve_knowledge(
    ctx: RunContextWrapper[ChattyRunContext],
    query: str,
    limit: Annotated[int, Field(ge=1, le=8)],
    scope: Literal["general", "product"],
) -> str:
    """全文检索政策或商品知识，为回答和推荐理由提供依据。

    Args:
        query: 关键词查询。
        limit: 最多返回的知识块数量。
        scope: general 检索政策等通用知识；product 只检索当前在售候选商品知识。
    """

    context = ctx.context

    # general 检索不限定商品；product 检索会在下面填入当前类目和有库存商品 ID。
    categories: list[str] = []
    product_ids: list[str] = []
    if scope == "product":
        # 这是运行时保护：即使类型允许 request 为 None，商品检索也明确禁止这种状态。
        if context.request is None:
            raise RuntimeError("recommendation_context_not_prepared")
        # 用户本轮明确类目优先；没有明确类目时才使用历史画像偏好。
        explicit_categories = context.request.context.preferred_categories
        profile = context.evidence.profile
        if profile is None:
            raise RuntimeError("profile_not_loaded")
        categories = explicit_categories or profile.preferred_categories
        product_ids = context.evidence.in_stock_product_order
    # 把所有有效参数变成稳定 JSON，作为重复调用保护的唯一标识。
    signature = json.dumps(
        {
            "query": query,
            "categories": categories,
            "product_ids": product_ids,
            "limit": limit,
            "scope": scope,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    guard_repeated_call(context.evidence, "retrieve_knowledge", signature)
    # hits 是经过 Pydantic 校验的 KnowledgeHit 列表，不是任意 dict。
    hits = context.catalog.retrieve_knowledge(
        query=query,
        categories=categories,
        product_ids=product_ids,
        limit=limit,
    )

    # general 知识只支撑回答；product 知识还要计算它能够支撑哪些推荐商品。
    product_specific_ids: set[str] = set()
    generic_categories: set[str] = set()
    if scope == "product":
        for hit in hits:
            # 商品专属文档只支撑自己的 product_id。
            if hit.product_id is not None:
                product_specific_ids.add(hit.product_id)
            else:
                # 类目通用文档可以支撑当前候选中同类目的全部商品。
                generic_categories.add(hit.category)

    generic_ids: set[str] = set()
    for product in context.catalog.inventory(product_ids):
        if product.category in generic_categories:
            generic_ids.add(product.product_id)
    # `|` 是集合并集：把两种来源支撑的商品 ID 合并并去重。
    grounded_ids = sorted(product_specific_ids | generic_ids)

    # 先记录 Harness Evidence，再把同一批命中序列化后返回给 Model。
    record_knowledge(context.evidence, hits, grounded_ids, scope=scope)
    return KNOWLEDGE_HITS_ADAPTER.dump_json(hits).decode()


@function_tool(
    name_override="get_marketing_strategy",
    failure_error_function=None,
    tool_input_guardrails=[stage_guardrail],
)
async def get_marketing_strategy(
    ctx: RunContextWrapper[ChattyRunContext],
) -> str:
    """获取画像分群对应的营销语气、写作要求与禁用词。"""

    context = ctx.context
    # 营销策略依赖用户分群，因此画像未加载时宁可明确失败，也不使用默认语气。
    if context.evidence.profile is None:
        raise RuntimeError("profile_not_loaded")
    segment = context.evidence.profile.segment
    strategy = context.catalog.marketing_strategy(segment)
    # 只有真实读取成功后才把 Tool 记入 used_tools。
    context.evidence.used_tools.append("get_marketing_strategy")
    return strategy.model_dump_json()


# 这是主 Agent 唯一可见的 Tool 清单。画像、搜索和库存由 Harness 提前确定性执行。
CHATTY_TOOLS = [
    retrieve_knowledge,
    get_marketing_strategy,
]
