from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Annotated

from agents import RunContextWrapper, function_tool
from agents.tool import Tool
from pydantic import Field

from chatty.catalog import Catalog
from chatty.models import (
    ExperimentGroup,
    KnowledgeHit,
    RecommendationRequest,
    UserProfile,
    UserSegment,
)

TOOL_NAMES = (
    "get_user_profile",
    "search_products",
    "check_inventory",
    "retrieve_knowledge",
    "get_marketing_strategy",
)


@dataclass
class RecommendationContext:
    """一次 Runner 执行的可验证状态，由五个 Tool 逐步填充。"""

    request: RecommendationRequest
    catalog: Catalog
    experiment_group: ExperimentGroup
    profile: UserProfile | None = None
    knowledge: list[KnowledgeHit] = field(default_factory=list)
    recalled_product_ids: set[str] = field(default_factory=set)
    in_stock_product_ids: set[str] = field(default_factory=set)
    knowledge_product_ids: set[str] = field(default_factory=set)
    used_tools: list[str] = field(default_factory=list)


def build_tools() -> list[Tool]:
    async def get_user_profile(ctx: RunContextWrapper[RecommendationContext]) -> str:
        """Load the demo profile and apply request context overrides."""
        context = ctx.context
        profile = context.catalog.user_profile(context.request.user_id, context.request.context)
        context.profile = profile
        context.used_tools.append("get_user_profile")
        return profile.model_dump_json()

    async def search_products(
        ctx: RunContextWrapper[RecommendationContext],
        categories: list[str],
        min_price_cents: Annotated[int, Field(ge=0)],
        max_price_cents: Annotated[int, Field(gt=0)],
        tags: list[str],
        limit: Annotated[int, Field(ge=1, le=20)],
    ) -> str:
        """Search products stored in SQLite by category, price and tags."""
        context = ctx.context
        if context.profile is None:
            raise ValueError("profile_not_loaded")
        profile = context.profile
        products = context.catalog.search(
            profile=profile,
            group=context.experiment_group,
            categories=categories,
            min_price_cents=min_price_cents,
            max_price_cents=max_price_cents,
            tags=tags,
            limit=limit,
        )
        # 保存搜索结果的 ID，而不是之后从模型文本反推“是否召回”。
        context.recalled_product_ids = {product.product_id for product in products}
        context.used_tools.append("search_products")
        return json.dumps(
            [product.model_dump(mode="json") for product in products],
            ensure_ascii=False,
        )

    async def check_inventory(
        ctx: RunContextWrapper[RecommendationContext],
        product_ids: list[str],
    ) -> str:
        """Return in-stock products and low-stock flags from SQLite."""
        context = ctx.context
        products = context.catalog.inventory(product_ids)
        # 这里只记录 SQLite 确认有货的商品，供最终输出做集合校验。
        context.in_stock_product_ids = {product.product_id for product in products}
        context.used_tools.append("check_inventory")
        return json.dumps(
            [
                {
                    "product_id": product.product_id,
                    "stock": product.stock,
                    "low_stock": product.stock <= 100,
                }
                for product in products
            ],
            ensure_ascii=False,
        )

    async def retrieve_knowledge(
        ctx: RunContextWrapper[RecommendationContext],
        query: Annotated[str, Field(min_length=1, max_length=200)],
        categories: list[str],
        product_ids: list[str],
        limit: Annotated[int, Field(ge=1, le=8)],
    ) -> str:
        """Retrieve product and marketing guidance within the requested scope."""
        context = ctx.context
        hits = context.catalog.retrieve_knowledge(
            query,
            categories=categories,
            product_ids=product_ids,
            limit=limit,
        )
        context.knowledge = hits
        # 这是有命中结果的检索请求范围，不代表每个商品都有独立 citation。
        context.knowledge_product_ids = set(product_ids) if hits else set()
        context.used_tools.append("retrieve_knowledge")
        return json.dumps(
            [hit.model_dump(mode="json") for hit in hits],
            ensure_ascii=False,
        )

    async def get_marketing_strategy(
        ctx: RunContextWrapper[RecommendationContext],
        segment: UserSegment,
    ) -> str:
        """Return the copy tone, instructions and forbidden words for a segment."""
        context = ctx.context
        if context.profile is None or segment != context.profile.segment:
            raise ValueError("marketing_segment_mismatch")
        strategy = context.catalog.marketing_strategy(segment)
        context.used_tools.append("get_marketing_strategy")
        return strategy.model_dump_json()

    return [
        function_tool(
            get_user_profile,
            name_override="get_user_profile",
            description_override="Load the current demo user's profile from SQLite.",
        ),
        function_tool(
            search_products,
            name_override="search_products",
            description_override="Search the SQLite product catalog.",
        ),
        function_tool(
            check_inventory,
            name_override="check_inventory",
            description_override="Validate SQLite inventory before recommending products.",
        ),
        function_tool(
            retrieve_knowledge,
            name_override="retrieve_knowledge",
            description_override="Retrieve product and marketing knowledge with SQLite FTS5.",
        ),
        function_tool(
            get_marketing_strategy,
            name_override="get_marketing_strategy",
            description_override="Load the marketing style for the user segment.",
        ),
    ]
