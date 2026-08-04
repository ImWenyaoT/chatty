from __future__ import annotations

import pytest
from agents.usage import Usage

from app.agent.evidence import (
    EvidenceError,
    RecommendationEvidence,
    guard_repeated_call,
    record_inventory,
    record_knowledge,
    record_run_usage,
    record_search,
    snapshot_evidence,
    validate_clarification_evidence,
    validate_recommendation_evidence,
    validate_tool_sequence,
)
from app.data.models import KnowledgeHit, RecommendationDraftItem, UserProfile


def profile() -> UserProfile:
    return UserProfile(
        user_id="U001",
        segment="active",
        preferred_categories=["耳机"],
        min_price_cents=0,
        max_price_cents=20000,
        recent_views=[],
        recent_purchases=[],
    )


def knowledge_hit() -> KnowledgeHit:
    return KnowledgeHit(
        doc_id="K054",
        title="蓝牙耳机指南",
        content="P023 支持蓝牙连接。",
        category="product",
        product_id="P023",
        source="fixture",
        chunk_ordinal=0,
        relevance_score=1.0,
    )


def draft_item() -> RecommendationDraftItem:
    return RecommendationDraftItem(
        product_id="P023",
        reason="符合预算",
        marketing_copy="适合日常使用",
    )


def test_snapshot_excludes_business_content() -> None:
    evidence = RecommendationEvidence()
    evidence.used_tools.extend(["get_user_profile", "search_products"])
    evidence.recalled_product_ids.add("P023")
    evidence.call_log.append('search_products({"max_price_cents": 30000})')

    snapshot = snapshot_evidence(evidence)

    assert snapshot.model_dump() == {
        "used_tools": ["get_user_profile", "search_products"],
        "profile_segment": None,
        "recalled_product_ids": ["P023"],
        "in_stock_product_ids": [],
        "grounded_product_ids": [],
        "knowledge_hits": 0,
        "call_log": ['search_products({"max_price_cents": 30000})'],
    }


def test_tool_sequence_allows_repeated_calls_and_independent_tail_tools() -> None:
    error = validate_tool_sequence(
        [
            "get_user_profile",
            "search_products",
            "search_products",
            "check_inventory",
            "get_marketing_strategy",
            "retrieve_knowledge",
        ]
    )

    assert error is None


def test_tool_sequence_rejects_broken_dependency_order() -> None:
    error = validate_tool_sequence(
        [
            "search_products",
            "get_user_profile",
            "check_inventory",
            "retrieve_knowledge",
            "get_marketing_strategy",
        ]
    )

    assert error is not None
    assert "依赖顺序错误" in error


def test_tool_sequence_requires_all_registered_tools() -> None:
    error = validate_tool_sequence(
        ["get_user_profile", "search_products", "check_inventory"]
    )

    assert error is not None
    assert "未调用的工具" in error


def test_clarification_requires_all_tools_and_no_available_product() -> None:
    evidence = RecommendationEvidence()
    evidence.used_tools.extend(
        [
            "get_user_profile",
            "search_products",
            "check_inventory",
            "retrieve_knowledge",
            "get_marketing_strategy",
        ]
    )

    validate_clarification_evidence(evidence)

    evidence.in_stock_product_ids.add("P023")
    with pytest.raises(EvidenceError, match="invalid_recommendation"):
        validate_clarification_evidence(evidence)


def test_clarification_rejects_incomplete_tool_sequence() -> None:
    evidence = RecommendationEvidence()
    evidence.used_tools.append("get_user_profile")

    with pytest.raises(EvidenceError) as caught:
        validate_clarification_evidence(evidence)

    assert caught.value.code == "required_tools_not_used"


def test_repeated_call_guard_allows_three_equal_calls() -> None:
    evidence = RecommendationEvidence()

    for _ in range(3):
        guard_repeated_call(evidence, "search_products", "{}")

    assert len(evidence.call_log) == 3


def test_repeated_call_guard_rejects_the_fourth_equal_call() -> None:
    evidence = RecommendationEvidence()

    for _ in range(3):
        guard_repeated_call(evidence, "search_products", "{}")

    with pytest.raises(RuntimeError, match="已达 3 次"):
        guard_repeated_call(evidence, "search_products", "{}")


def test_recommendation_requires_all_three_product_fact_sets() -> None:
    evidence = RecommendationEvidence()
    evidence.profile = profile()
    evidence.used_tools.append("get_user_profile")

    record_search(evidence, ["P023"])
    record_inventory(evidence, ["P023"])
    record_knowledge(
        evidence,
        [knowledge_hit()],
        ["P023"],
        scope="product",
    )
    evidence.used_tools.append("get_marketing_strategy")

    draft = [draft_item()]
    validate_recommendation_evidence(evidence, draft)


def test_general_knowledge_is_tracked_separately_from_product_grounding() -> None:
    evidence = RecommendationEvidence()
    hits = [knowledge_hit()]

    record_knowledge(evidence, hits, [], scope="general")

    assert evidence.general_knowledge_hits == 1
    assert evidence.knowledge_product_ids == set()


@pytest.mark.parametrize(
    ("missing_set", "expected_code"),
    [
        ("recalled_product_ids", "product_not_recalled"),
        ("in_stock_product_ids", "inventory_not_checked"),
        ("knowledge_product_ids", "product_not_grounded"),
    ],
)
def test_recommendation_rejects_missing_product_fact(
    missing_set: str,
    expected_code: str,
) -> None:
    evidence = RecommendationEvidence()
    evidence.profile = profile()
    evidence.knowledge.append(knowledge_hit())
    evidence.used_tools.extend(
        [
            "get_user_profile",
            "search_products",
            "check_inventory",
            "retrieve_knowledge",
            "get_marketing_strategy",
        ]
    )
    evidence.recalled_product_ids.add("P023")
    evidence.in_stock_product_ids.add("P023")
    evidence.knowledge_product_ids.add("P023")
    getattr(evidence, missing_set).clear()

    draft = [draft_item()]

    with pytest.raises(EvidenceError) as caught:
        validate_recommendation_evidence(evidence, draft)

    assert caught.value.code == expected_code
    assert caught.value.missing == ["P023"]


def test_sdk_usage_is_recorded_for_agent_evaluation() -> None:
    evidence = RecommendationEvidence()

    record_run_usage(
        evidence,
        Usage(requests=2, input_tokens=1200, output_tokens=180, total_tokens=1380),
    )

    assert evidence.usage.requests == 2
    assert evidence.usage.input_tokens == 1200
    assert evidence.usage.output_tokens == 180
    assert evidence.usage.total_tokens == 1380
