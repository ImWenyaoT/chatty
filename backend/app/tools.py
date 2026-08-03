from __future__ import annotations

import json
from dataclasses import dataclass

from agents import RunContextWrapper, function_tool
from pydantic import BaseModel

from app.catalog import Catalog
from app.evidence import (
    RecommendationEvidence,
    guard_repeated_call,
    record_inventory,
    record_knowledge,
    record_search,
)
from app.models import RecommendationRequest


@dataclass
class ChattyRunContext:
    request: RecommendationRequest
    catalog: Catalog
    evidence: RecommendationEvidence


def _json(value: object) -> str:
    """把 Tool 的 Pydantic 结果转换成模型可见的 JSON。"""

    if isinstance(value, BaseModel):
        value = value.model_dump()
    if isinstance(value, list):
        serialized_items: list[object] = []
        for item in value:
            if isinstance(item, BaseModel):
                serialized_items.append(item.model_dump())
            else:
                serialized_items.append(item)
        value = serialized_items
    return json.dumps(value, ensure_ascii=False)


@function_tool(name_override="get_user_profile", failure_error_function=None)
async def get_user_profile(ctx: RunContextWrapper[ChattyRunContext]) -> str:
    """获取当前用户画像。必须先调用；只读当前请求用户，不能修改画像。"""

    request = ctx.context.request
    profile = ctx.context.catalog.user_profile(request.user_id, request.context)
    ctx.context.evidence.profile = profile
    ctx.context.evidence.used_tools.append("get_user_profile")
    return _json(profile)


@function_tool(name_override="search_products", failure_error_function=None)
async def search_products(
    ctx: RunContextWrapper[ChattyRunContext],
    categories: list[str],
    min_price_cents: int,
    max_price_cents: int,
    limit: int,
) -> str:
    """按类目和价格搜索候选商品；价格单位为分，结果尚未检查库存。

    Args:
        categories: 候选类目。
        min_price_cents: 最低价格，单位为分。
        max_price_cents: 最高价格，单位为分。
        limit: 最多返回的候选数量。
    """

    context = ctx.context
    if context.evidence.profile is None:
        raise RuntimeError("profile_not_loaded")

    explicit = context.request.context

    # 用户本轮明确说出的条件优先于模型重复填写的 Tool 参数。
    effective_categories = categories
    if explicit.preferred_categories:
        effective_categories = explicit.preferred_categories

    effective_min = min_price_cents
    if explicit.min_price_cents is not None:
        effective_min = max(min_price_cents, explicit.min_price_cents)

    effective_max = max_price_cents
    if explicit.max_price_cents is not None:
        effective_max = min(max_price_cents, explicit.max_price_cents)
    signature = json.dumps(
        {
            "categories": effective_categories,
            "min_price_cents": effective_min,
            "max_price_cents": effective_max,
            "limit": limit,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    guard_repeated_call(context.evidence, "search_products", signature)
    products = context.catalog.search(
        profile=context.evidence.profile,
        categories=effective_categories,
        min_price_cents=effective_min,
        max_price_cents=effective_max,
        limit=limit,
    )
    record_search(context.evidence, [product.product_id for product in products])
    return _json(products)


@function_tool(name_override="check_inventory", failure_error_function=None)
async def check_inventory(
    ctx: RunContextWrapper[ChattyRunContext], product_ids: list[str]
) -> str:
    """检查搜索召回商品的库存；搜索为空时传空数组。

    Args:
        product_ids: search_products 已经返回过的商品 ID。
    """

    context = ctx.context
    unknown = set(product_ids) - context.evidence.recalled_product_ids
    if unknown:
        raise RuntimeError("inventory_product_not_recalled")
    products = context.catalog.inventory(product_ids)
    record_inventory(context.evidence, [product.product_id for product in products])
    result = [
        {
            "product_id": product.product_id,
            "stock": product.stock,
            "low_stock": product.stock <= 100,
        }
        for product in products
    ]
    return _json(result)


@function_tool(name_override="retrieve_knowledge", failure_error_function=None)
async def retrieve_knowledge(
    ctx: RunContextWrapper[ChattyRunContext],
    query: str,
    categories: list[str],
    product_ids: list[str],
    limit: int,
) -> str:
    """全文检索商品与营销知识，为推荐理由提供依据。

    Args:
        query: 关键词查询。
        categories: 需要限定的类目。
        product_ids: check_inventory 返回的在售商品 ID。
        limit: 最多返回的知识块数量。
    """

    context = ctx.context
    unknown = set(product_ids) - context.evidence.in_stock_product_ids
    if unknown:
        raise RuntimeError("knowledge_product_not_in_stock")
    signature = json.dumps(
        {
            "query": query,
            "categories": categories,
            "product_ids": product_ids,
            "limit": limit,
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

    # 商品专属文档只能支撑该商品；类目通用文档可以支撑同类在售商品。
    product_specific_ids: set[str] = set()
    generic_categories: set[str] = set()
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
    record_knowledge(context.evidence, hits, grounded_ids)
    return _json(hits)


@function_tool(name_override="get_marketing_strategy", failure_error_function=None)
async def get_marketing_strategy(
    ctx: RunContextWrapper[ChattyRunContext], segment: str
) -> str:
    """获取画像分群对应的营销语气、写作要求与禁用词。

    Args:
        segment: get_user_profile 返回的用户分群。
    """

    context = ctx.context
    if context.evidence.profile is None:
        raise RuntimeError("profile_not_loaded")
    if segment != context.evidence.profile.segment:
        raise RuntimeError("marketing_segment_mismatch")
    strategy = context.catalog.marketing_strategy(segment)
    context.evidence.used_tools.append("get_marketing_strategy")
    return _json(strategy)


CHATTY_TOOLS = [
    get_user_profile,
    search_products,
    check_inventory,
    retrieve_knowledge,
    get_marketing_strategy,
]
