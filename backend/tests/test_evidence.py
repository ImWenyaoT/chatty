from __future__ import annotations

import pytest

from app.evidence import (
    EvidenceError,
    RecommendationEvidence,
    guard_repeated_call,
    record_inventory,
    record_knowledge,
    record_search,
    snapshot_evidence,
    validate_recommendation_evidence,
    validate_tool_sequence,
)
from app.models import KnowledgeHit, RecommendationDraftItem, UserProfile


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
    evidence.profile = UserProfile.model_construct(segment="active")
    evidence.used_tools.append("get_user_profile")

    record_search(evidence, ["P023"])
    record_inventory(evidence, ["P023"])
    record_knowledge(
        evidence,
        [KnowledgeHit.model_construct()],
        ["P023"],
    )
    evidence.used_tools.append("get_marketing_strategy")

    draft = [RecommendationDraftItem.model_construct(product_id="P023")]
    validate_recommendation_evidence(evidence, draft)


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
    evidence.profile = UserProfile.model_construct(segment="active")
    evidence.knowledge.append(KnowledgeHit.model_construct())
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

    draft = [RecommendationDraftItem.model_construct(product_id="P023")]

    with pytest.raises(EvidenceError) as caught:
        validate_recommendation_evidence(evidence, draft)

    assert caught.value.code == expected_code
    assert caught.value.missing == ["P023"]
