from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass

from app.agent import Chatty, ChattyContext, ChattyError
from app.data.catalog import Catalog
from app.data.models import (
    ClarifyReply,
    KnowledgeReply,
    Product,
    RecommendationResponse,
    Reply,
)
from app.model_provider import ResponsesModelProvider


@dataclass(frozen=True)
class AgentCase:
    name: str
    user_id: str
    user_text: str
    expected_action: str
    expected_category: str | None = None
    max_price_cents: int | None = None
    forbidden_product_ids: frozenset[str] = frozenset()
    expected_answer_terms: tuple[str, ...] = ()


CASES = [
    AgentCase(
        "200 元耳机没有可售候选",
        "user_budget",
        "请推荐 200 元以内的耳机",
        "clarify",
        max_price_cents=20_000,
    ),
    AgentCase(
        "300 元耳机可以推荐",
        "user_budget",
        "请推荐 300 元以内的耳机",
        "recommend",
        "耳机",
        30_000,
    ),
    AgentCase(
        "本轮手机需求覆盖历史画像",
        "user_active",
        "请推荐 1500 元以内的手机",
        "recommend",
        "手机",
        150_000,
    ),
    AgentCase(
        "有可售替代时不会推荐售罄商品",
        "user_vip",
        "请推荐 3000 元以内的数码产品",
        "recommend",
        "数码",
        300_000,
        frozenset({"P015"}),
    ),
    AgentCase(
        "价格敏感用户可以买配件",
        "user_budget",
        "请推荐 150 元以内的配件",
        "recommend",
        "配件",
        15_000,
    ),
    AgentCase(
        "配送政策问答",
        "user_budget",
        "你们使用哪家快递公司？",
        "answer",
        expected_answer_terms=("合作快递", "订单"),
    ),
    AgentCase(
        "商品推荐与退货政策混合请求",
        "user_budget",
        "推荐 300 元以内的耳机，并告诉我七天无理由退货条件",
        "recommend",
        "耳机",
        30_000,
        expected_answer_terms=("七天", "完好"),
    ),
]


def reply_action(reply: Reply) -> str:
    if isinstance(reply, ClarifyReply):
        return "clarify"
    if isinstance(reply, KnowledgeReply):
        return "answer"
    return "recommend"


def answer_contains(reply: Reply, expected_terms: tuple[str, ...]) -> bool:
    if not expected_terms:
        return True
    answer = reply.answer or ""
    return all(term in answer for term in expected_terms)


def case_succeeds(
    case: AgentCase,
    reply: Reply,
    products_by_id: dict[str, Product],
) -> bool:
    products_valid = True
    if isinstance(reply, RecommendationResponse):
        products_valid = bool(reply.products)
        for product in reply.products:
            stored_product = products_by_id.get(product.product_id)
            if stored_product is None:
                products_valid = False
                continue
            if product.name != stored_product.name:
                products_valid = False
            if product.category != stored_product.category:
                products_valid = False
            if product.price_cents != stored_product.price_cents:
                products_valid = False
            if product.brand != stored_product.brand:
                products_valid = False
            if product.stock != stored_product.stock:
                products_valid = False
            if product.tags != stored_product.tags:
                products_valid = False
            if product.stock <= 0:
                products_valid = False
            if (
                case.max_price_cents is not None
                and product.price_cents > case.max_price_cents
            ):
                products_valid = False
            if product.product_id in case.forbidden_product_ids:
                products_valid = False
            if (
                case.expected_category is not None
                and product.category != case.expected_category
            ):
                products_valid = False
    return (
        reply_action(reply) == case.expected_action
        and products_valid
        and answer_contains(reply, case.expected_answer_terms)
    )


async def main() -> None:
    provider = ResponsesModelProvider()
    if not provider.configured:
        raise RuntimeError("请在 .env.local、.env 或系统环境配置 DEEPSEEK_API_KEY")

    passed = 0
    try:
        for case in CASES:
            catalog = Catalog()
            try:
                turn = await Chatty(catalog, provider).run(
                    case.user_id,
                    case.user_text,
                    ChattyContext(),
                )
                reply = turn.reply
                products_by_id = {
                    product.product_id: product for product in catalog.products
                }
                action = reply_action(reply)
                success = case_succeeds(case, reply, products_by_id)
                passed += int(success)
                print(
                    json.dumps(
                        {
                            "case": case.name,
                            "success": success,
                            "expected_action": case.expected_action,
                            "actual_action": action,
                            "latency_ms": round(turn.latency_ms, 1),
                            "model_requests": turn.usage.requests,
                            "input_tokens": turn.usage.input_tokens,
                            "output_tokens": turn.usage.output_tokens,
                            "total_tokens": turn.usage.total_tokens,
                        },
                        ensure_ascii=False,
                    )
                )
            except ChattyError as error:
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
