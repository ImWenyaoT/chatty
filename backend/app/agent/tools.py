"""主 Agent 可调用的知识检索与营销策略 Tool。"""

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
    request: RecommendationRequest | None
    catalog: Catalog
    evidence: RecommendationEvidence
    batch_stage: WorkflowStage | None = None
    batch_decisions: dict[str, GateDecision] = field(default_factory=dict)


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
    categories: list[str] = []
    product_ids: list[str] = []
    if scope == "product":
        if context.request is None:
            raise RuntimeError("recommendation_context_not_prepared")
        explicit_categories = context.request.context.preferred_categories
        profile = context.evidence.profile
        if profile is None:
            raise RuntimeError("profile_not_loaded")
        categories = explicit_categories or profile.preferred_categories
        product_ids = context.evidence.in_stock_product_order
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
    hits = context.catalog.retrieve_knowledge(
        query=query,
        categories=categories,
        product_ids=product_ids,
        limit=limit,
    )

    # general 知识只支撑回答；product 知识还可支撑推荐商品。
    product_specific_ids: set[str] = set()
    generic_categories: set[str] = set()
    if scope == "product":
        for hit in hits:
            if hit.product_id is not None:
                product_specific_ids.add(hit.product_id)
            else:
                generic_categories.add(hit.category)

    generic_ids: set[str] = set()
    for product in context.catalog.inventory(product_ids):
        if product.category in generic_categories:
            generic_ids.add(product.product_id)
    grounded_ids = sorted(product_specific_ids | generic_ids)
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
    if context.evidence.profile is None:
        raise RuntimeError("profile_not_loaded")
    segment = context.evidence.profile.segment
    strategy = context.catalog.marketing_strategy(segment)
    context.evidence.used_tools.append("get_marketing_strategy")
    return strategy.model_dump_json()


CHATTY_TOOLS = [
    retrieve_knowledge,
    get_marketing_strategy,
]
