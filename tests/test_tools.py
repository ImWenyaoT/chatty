import json

from chatty.catalog import Catalog
from chatty.models import RecommendationRequest
from chatty.tools import (
    TOOL_NAMES,
    RecommendationContext,
    build_tools,
    inventory_payload,
    knowledge_payload,
    marketing_payload,
    product_search_payload,
    profile_payload,
)


def test_five_tools_have_one_purpose_each() -> None:
    assert tuple(tool.name for tool in build_tools()) == TOOL_NAMES


def test_tool_payloads_use_run_context_and_catalog() -> None:
    context = RecommendationContext(
        request=RecommendationRequest(user_id="user_active"),
        catalog=Catalog(),
        experiment_group="treatment_personalized",
    )

    profile = json.loads(profile_payload(context))
    assert profile["user_id"] == "user_active"

    products = json.loads(
        product_search_payload(
            context,
            categories=["耳机"],
            min_price_cents=0,
            max_price_cents=300_000,
            tags=[],
            limit=5,
        )
    )
    assert products
    assert {product["category"] for product in products} == {"耳机"}

    inventory = json.loads(inventory_payload(context, ["P003", "P015"]))
    assert [item["product_id"] for item in inventory] == ["P003"]

    knowledge = json.loads(
        knowledge_payload(
            context,
            query="降噪 耳机",
            categories=["耳机"],
            product_ids=["P003", "P004"],
            limit=3,
        )
    )
    assert knowledge
    assert {item["category"] for item in knowledge} == {"耳机"}
    strategy = json.loads(marketing_payload(context, profile["segment"]))
    assert strategy["segment"] == "active"
    assert context.used_tools == set(TOOL_NAMES)
