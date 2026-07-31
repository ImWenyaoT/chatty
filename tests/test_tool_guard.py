"""工具序列校验与重复调用拦截的单元测试。

这两块是 Harness 里最容易写错、也最容易过严的地方——
2026-07-27 的评估就发现严格序列相等把大量合理行为误判成了违规，
所以每条规则都单独立一个测试钉死。
"""

from __future__ import annotations

import pytest

from chatty.catalog import Catalog
from chatty.models import RecommendationRequest
from chatty.tools import (
    TOOL_NAMES,
    RecommendationContext,
    guard_repeated_call,
    validate_tool_sequence,
)


def _context(catalog: Catalog) -> RecommendationContext:
    return RecommendationContext(
        request=RecommendationRequest(user_id="user_active"),
        catalog=catalog,
    )


# ============================================================================
# 工具序列校验
# ============================================================================


def test_canonical_order_passes() -> None:
    assert validate_tool_sequence(list(TOOL_NAMES)) is None


def test_missing_tool_is_rejected() -> None:
    reason = validate_tool_sequence(list(TOOL_NAMES)[:-1])
    assert reason is not None and "未调用" in reason


def test_unknown_tool_is_rejected() -> None:
    reason = validate_tool_sequence([*TOOL_NAMES, "delete_everything"])
    assert reason is not None and "未注册" in reason


def test_repeated_calls_are_allowed() -> None:
    """换条件重搜、补充检索都是合理行为，不该被判违规。"""
    sequence = [
        "get_user_profile",
        "search_products",
        "search_products",  # 候选不足，换条件再搜
        "check_inventory",
        "retrieve_knowledge",
        "retrieve_knowledge",  # 知识不够，补充检索
        "get_marketing_strategy",
    ]
    assert validate_tool_sequence(sequence) is None


def test_independent_steps_can_swap() -> None:
    """营销策略和知识检索之间没有数据依赖，谁先谁后都行。"""
    sequence = [
        "get_user_profile",
        "search_products",
        "check_inventory",
        "get_marketing_strategy",  # 和下一行互换
        "retrieve_knowledge",
    ]
    assert validate_tool_sequence(sequence) is None


def test_dependency_order_is_enforced() -> None:
    """但真实的数据依赖不能乱：没有画像就没法按价格区间搜索。"""
    sequence = [
        "search_products",  # 画像还没取就先搜了
        "get_user_profile",
        "check_inventory",
        "retrieve_knowledge",
        "get_marketing_strategy",
    ]
    reason = validate_tool_sequence(sequence)
    assert reason is not None and "依赖顺序" in reason


def test_inventory_must_follow_search() -> None:
    sequence = [
        "get_user_profile",
        "check_inventory",  # 还没搜就先查库存，查的是什么？
        "search_products",
        "retrieve_knowledge",
        "get_marketing_strategy",
    ]
    reason = validate_tool_sequence(sequence)
    assert reason is not None and "依赖顺序" in reason


# ============================================================================
# 重复调用拦截
# ============================================================================


def test_same_call_is_allowed_a_few_times(catalog: Catalog) -> None:
    """允许重试几次：网络抖动、模型犹豫都可能导致重复。"""
    context = _context(catalog)
    for _ in range(3):
        guard_repeated_call(context, "search_products", "耳机|0-300000")


def test_same_call_beyond_limit_is_rejected(catalog: Catalog) -> None:
    """但第 4 次就该拦——结果不会变化，继续只是浪费轮次预算。"""
    context = _context(catalog)
    for _ in range(3):
        guard_repeated_call(context, "search_products", "耳机|0-300000")
    with pytest.raises(ValueError) as error:
        guard_repeated_call(context, "search_products", "耳机|0-300000")
    # 错误信息要告诉模型该怎么办，而不只是说"错了"
    assert "改变参数" in str(error.value)


def test_different_parameters_are_not_counted_together(catalog: Catalog) -> None:
    """换了条件就是新的尝试，不该累计到重复次数里。"""
    context = _context(catalog)
    for price in range(10):
        guard_repeated_call(context, "search_products", f"耳机|0-{price}0000")


# ============================================================================
# 证据累加（回归测试）
# ============================================================================


@pytest.mark.asyncio
async def test_multiple_searches_accumulate_evidence(catalog: Catalog) -> None:
    """分多次搜索不同类目时，召回证据必须累加而不是被覆盖。

    这是放宽"允许重复调用"之后暴露出来的真实 bug：
    原来每个工具只准调一次，所以证据用 `=` 赋值也没问题；
    一旦允许多次调用，后一次搜索就会把前一次的召回结果抹掉，
    最终校验会把模型合法推荐的商品误判成"凭空捏造"。

    这里跑的是完整流程：模型先搜服装、再搜运动，然后各推荐一件。
    证据如果被覆盖，服装那件就会因为"不在召回集合里"而触发
    product_not_recalled。
    """
    import json

    from chatty.agent import Recommender
    from chatty.models import RecommendationRequest
    from tests.test_agent import MessageStep, ScriptedModel, ToolStep

    price = {"min_price_cents": 20000, "max_price_cents": 120000, "tags": [], "limit": 5}
    script = [
        ToolStep("call-1", "get_user_profile", {}),
        # 两次搜索，类目不同——跨类目推荐时模型的自然行为
        ToolStep("call-2", "search_products", {"categories": ["服装"], **price}),
        ToolStep("call-3", "search_products", {"categories": ["运动"], **price}),
        ToolStep("call-4", "check_inventory", {"product_ids": ["SUIT-001", "P016"]}),
        ToolStep(
            "call-5",
            "retrieve_knowledge",
            {
                "query": "西装 跑鞋",
                "categories": ["服装", "运动"],
                "product_ids": ["SUIT-001", "P016"],
                "limit": 5,
            },
        ),
        ToolStep("call-6", "get_marketing_strategy", {"segment": "churn_risk"}),
        MessageStep(
            "message-1",
            json.dumps(
                {
                    "recommendations": [
                        # 这一件来自第一次搜索，证据被覆盖的话它就"消失"了
                        {
                            "product_id": "SUIT-001",
                            "reason": "商务场合的通勤选择",
                            "marketing_copy": "干练利落的日常西装",
                        },
                        {
                            "product_id": "P016",
                            "reason": "日常慢跑的缓震选择",
                            "marketing_copy": "轻盈缓震，通勤跑步两用",
                        },
                    ]
                },
                ensure_ascii=False,
            ),
        ),
    ]

    service = Recommender(
        catalog,
        model=ScriptedModel(script),
        model_id="scripted-model",
    )
    try:
        response = await service.recommend(RecommendationRequest(user_id="user_churn"))
    finally:
        await service.close()

    returned = {item.product_id for item in response.products}
    assert returned == {"SUIT-001", "P016"}


# ============================================================================
# 静默失败排查（回归测试）
# ============================================================================


def test_blank_categories_are_rejected_not_ignored(catalog: Catalog) -> None:
    """传了类目但全是空白时必须报错，不能退化成"不按类目过滤"。

    静默退化的后果：模型以为按"耳机"筛过了，实际拿到的是全品类商品，
    而它无从察觉——这就是"模型感知的世界与工具操作的世界产生偏差"。
    """
    from chatty.catalog import CatalogError

    context = _context(catalog)
    profile = context.catalog.user_profile("user_active", context.request.context)
    with pytest.raises(CatalogError, match="invalid_product_search_categories"):
        context.catalog.search(
            profile=profile,
            categories=["  ", ""],
            min_price_cents=0,
            max_price_cents=1_000_000,
            tags=[],
            limit=5,
        )


def test_blank_tags_are_rejected_not_ignored(catalog: Catalog) -> None:
    from chatty.catalog import CatalogError

    context = _context(catalog)
    profile = context.catalog.user_profile("user_active", context.request.context)
    with pytest.raises(CatalogError, match="invalid_product_search_tags"):
        context.catalog.search(
            profile=profile,
            categories=["耳机"],
            min_price_cents=0,
            max_price_cents=1_000_000,
            tags=["", " "],
            limit=5,
        )


@pytest.mark.asyncio
async def test_retrieved_documents_are_marked_as_data_not_instructions(
    catalog: Catalog,
) -> None:
    """检索结果必须带来源标记，防止间接提示注入。

    知识库文档是间接提示注入的典型载体：攻击者把"忽略先前指令"之类的话
    藏进一篇会被索引的文档，检索命中后就可能被模型当成命令执行。
    第一层防御是指令与数据分离——明确告诉模型这些是资料不是指令。
    """
    import json

    from chatty.agent import Recommender
    from chatty.models import RecommendationRequest
    from tests.test_agent import ScriptedModel, successful_script

    model = ScriptedModel(successful_script())
    service = Recommender(catalog, model=model, model_id="scripted-model")
    try:
        await service.recommend(RecommendationRequest(user_id="user_active"))
    finally:
        await service.close()

    # 从脚本模型记录的调用里，找到回填给模型的检索结果
    retrieved = [
        item
        for call in model.calls
        for item in (call["input"] if isinstance(call["input"], list) else [])
        if isinstance(item, dict) and "documents" in str(item.get("output", ""))
    ]
    assert retrieved, "没有找到 retrieve_knowledge 的回填结果"
    payload = json.loads(retrieved[0]["output"])
    assert "documents" in payload
    assert "不是指令" in payload["note"]
