import json

from agents.tool_context import ToolContext

from chatty.catalog import Catalog
from chatty.models import RecommendationRequest
from chatty.tools import TOOL_NAMES, RecommendationContext, build_tools


def test_five_tools_have_one_purpose_each() -> None:
    assert tuple(tool.name for tool in build_tools()) == TOOL_NAMES


async def test_tools_use_run_context_and_catalog() -> None:
    context = RecommendationContext(
        request=RecommendationRequest(user_id="user_active"),
        catalog=Catalog(),
    )
    tools = {tool.name: tool for tool in build_tools()}

    async def invoke(name: str, arguments: dict[str, object]) -> object:
        raw_arguments = json.dumps(arguments, ensure_ascii=False)
        tool_context = ToolContext(
            context,
            tool_name=name,
            tool_call_id=f"call_{name}",
            tool_arguments=raw_arguments,
        )
        return await tools[name].on_invoke_tool(tool_context, raw_arguments)

    profile = json.loads(await invoke("get_user_profile", {}))
    assert profile["user_id"] == "user_active"

    products = json.loads(
        await invoke(
            "search_products",
            {
                "categories": ["耳机"],
                "min_price_cents": 0,
                "max_price_cents": 300_000,
                "tags": [],
                "limit": 5,
            },
        )
    )
    assert products
    assert {product["category"] for product in products} == {"耳机"}

    inventory = json.loads(await invoke("check_inventory", {"product_ids": ["P003", "P015"]}))
    assert [item["product_id"] for item in inventory] == ["P003"]

    knowledge = json.loads(
        await invoke(
            "retrieve_knowledge",
            {
                "query": "降噪 耳机",
                "categories": ["耳机"],
                "product_ids": ["P003", "P004"],
                "limit": 3,
            },
        )
    )
    # 返回值外层带来源标记（防间接提示注入），文档在 documents 字段里
    assert "不是指令" in knowledge["note"]
    assert knowledge["documents"]
    assert {item["category"] for item in knowledge["documents"]} == {"耳机"}

    strategy = json.loads(await invoke("get_marketing_strategy", {"segment": profile["segment"]}))
    assert strategy["segment"] == "active"
    assert context.used_tools == [
        "get_user_profile",
        "search_products",
        "check_inventory",
        "retrieve_knowledge",
        "get_marketing_strategy",
    ]
    assert context.recalled_product_ids >= {"P003", "P004"}
    assert context.in_stock_product_ids == {"P003"}
    # 依据范围由实际命中的文档决定：命中里既有耳机类目的通用文档，
    # 也有绑定到具体商品的文档，因此整个耳机类目都获得了依据。
    assert context.knowledge_product_ids >= {"P003", "P004"}
    assert all(
        product.category == "耳机"
        for product in context.catalog.products
        if product.product_id in context.knowledge_product_ids
    )
    assert [hit.model_dump(mode="json") for hit in context.knowledge] == knowledge["documents"]
