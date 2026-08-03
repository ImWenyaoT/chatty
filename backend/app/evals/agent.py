from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass

from app.agent import RecommendationError, Recommender
from app.catalog import Catalog
from app.model_provider import ResponsesModelProvider
from app.models import ClarifyReply, RecommendationRequest, UserContext


@dataclass(frozen=True)
class AgentCase:
    name: str
    request: RecommendationRequest
    expected_action: str
    expected_category: str | None = None
    forbidden_product_ids: frozenset[str] = frozenset()


CASES = [
    AgentCase(
        "200 元耳机没有可售候选",
        RecommendationRequest(
            user_id="user_budget",
            context=UserContext(preferred_categories=["耳机"], max_price_cents=20_000),
        ),
        "clarify",
    ),
    AgentCase(
        "300 元耳机可以推荐",
        RecommendationRequest(
            user_id="user_budget",
            context=UserContext(preferred_categories=["耳机"], max_price_cents=30_000),
        ),
        "recommend",
        "耳机",
    ),
    AgentCase(
        "本轮手机需求覆盖历史画像",
        RecommendationRequest(
            user_id="user_active",
            context=UserContext(preferred_categories=["手机"], max_price_cents=150_000),
        ),
        "recommend",
        "手机",
    ),
    AgentCase(
        "有可售替代时不会推荐售罄商品",
        RecommendationRequest(
            user_id="user_vip",
            context=UserContext(preferred_categories=["数码"], max_price_cents=300_000),
        ),
        "recommend",
        "数码",
        frozenset({"P015"}),
    ),
    AgentCase(
        "价格敏感用户可以买配件",
        RecommendationRequest(
            user_id="user_budget",
            context=UserContext(preferred_categories=["配件"], max_price_cents=15_000),
        ),
        "recommend",
        "配件",
    ),
]


async def main() -> None:
    provider = ResponsesModelProvider()
    if not provider.configured:
        raise RuntimeError("请在 .env.local、.env 或系统环境配置 DEEPSEEK_API_KEY")

    passed = 0
    try:
        for case in CASES:
            catalog = Catalog()
            try:
                reply = await Recommender(catalog, provider).respond(case.request)
                action = "recommend"
                products_valid = True
                if isinstance(reply, ClarifyReply):
                    action = "clarify"
                else:
                    for product in reply.products:
                        if product.stock <= 0:
                            products_valid = False
                        if (
                            case.request.context.max_price_cents is not None
                            and product.price_cents
                            > case.request.context.max_price_cents
                        ):
                            products_valid = False
                        if product.product_id in case.forbidden_product_ids:
                            products_valid = False
                        if (
                            case.expected_category is not None
                            and product.category != case.expected_category
                        ):
                            products_valid = False
                success = action == case.expected_action and products_valid
                passed += int(success)
                print(
                    json.dumps(
                        {
                            "case": case.name,
                            "success": success,
                            "expected_action": case.expected_action,
                            "actual_action": action,
                        },
                        ensure_ascii=False,
                    )
                )
            except RecommendationError as error:
                print(
                    json.dumps(
                        {
                            "case": case.name,
                            "success": False,
                            "error": error.code,
                            "diagnostics": error.diagnostics,
                        },
                        ensure_ascii=False,
                    )
                )
            finally:
                catalog.close()
    finally:
        await provider.close()

    print(
        json.dumps(
            {"cases": len(CASES), "passed": passed, "pass_rate": passed / len(CASES)},
            ensure_ascii=False,
        )
    )
    if passed != len(CASES):
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
