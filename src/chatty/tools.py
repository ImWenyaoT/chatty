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
    request: RecommendationRequest
    catalog: Catalog
    experiment_group: ExperimentGroup
    profile: UserProfile | None = None
    knowledge: list[KnowledgeHit] = field(default_factory=list)
    recalled_product_ids: set[str] = field(default_factory=set)
    in_stock_product_ids: set[str] = field(default_factory=set)
    knowledge_product_ids: set[str] = field(default_factory=set)
    used_tools: set[str] = field(default_factory=set)

def build_tools() -> list[Tool]:
    async def get_user_profile(ctx: RunContextWrapper[RecommendationContext]) -> str:
        """Load the demo profile and apply request context overrides."""
        context = ctx.context
        profile = context.catalog.user_profile(context.request.user_id, context.request.context)
        context.profile = profile
        context.used_tools.add("get_user_profile")
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
        profile = context.profile or context.catalog.user_profile(
            context.request.user_id, context.request.context
        )
        products = context.catalog.search(
            profile=profile,
            group=context.experiment_group,
            categories=categories,
            min_price_cents=min_price_cents,
            max_price_cents=max_price_cents,
            tags=tags,
            limit=limit,
        )
        context.recalled_product_ids.update(product.product_id for product in products)
        context.used_tools.add("search_products")
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
        context.in_stock_product_ids.update(product.product_id for product in products)
        context.used_tools.add("check_inventory")
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
        """Retrieve grounded product and marketing guidance from SQLite FTS5."""
        context = ctx.context
        hits = context.catalog.retrieve_knowledge(
            query,
            categories=categories,
            product_ids=product_ids,
            limit=limit,
        )
        known_doc_ids = {hit.doc_id for hit in context.knowledge}
        context.knowledge.extend(hit for hit in hits if hit.doc_id not in known_doc_ids)
        if hits:
            context.knowledge_product_ids.update(product_ids)
        context.used_tools.add("retrieve_knowledge")
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
        strategy = context.catalog.marketing_strategy(segment)
        context.used_tools.add("get_marketing_strategy")
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
