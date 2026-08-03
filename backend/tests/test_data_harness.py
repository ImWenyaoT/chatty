from pathlib import Path

import pytest
from pydantic import ValidationError

from app.catalog import Catalog, CatalogError
from app.database import DATA_DIR, segment_for_index, split_into_chunks
from app.models import (
    AgentDraft,
    RecommendationDraftItem,
    RecommendationRequest,
    UserContext,
)


@pytest.fixture
def catalog(tmp_path: Path):
    instance = Catalog(database_path=tmp_path / "chatty.db", data_dir=DATA_DIR)
    try:
        yield instance
    finally:
        instance.close()


def test_chinese_indexing_and_sentence_chunks() -> None:
    assert segment_for_index("降噪 iPhone") == " 降  噪  iPhone"
    assert split_into_chunks("第一句。第二句。第三句。", target=8, overlap=0) == [
        "第一句。第二句。",
        "第三句。",
    ]


def test_fts_returns_original_chunk(catalog: Catalog) -> None:
    hits = catalog.retrieve_knowledge(
        query="降噪 耳机 通勤",
        categories=["耳机"],
        product_ids=[],
        limit=3,
    )

    assert hits
    assert "降噪" in hits[0].content
    assert " 降  噪 " not in hits[0].content
    assert hits[0].relevance_score > 0


def test_single_price_override_opens_the_other_boundary(catalog: Catalog) -> None:
    upper_bound = catalog.user_profile(
        "user_active", UserContext(max_price_cents=30_000)
    )
    lower_bound = catalog.user_profile(
        "user_budget", UserContext(min_price_cents=200_000)
    )

    assert upper_bound.min_price_cents == 0
    assert upper_bound.max_price_cents == 30_000
    assert lower_bound.min_price_cents == 200_000
    assert lower_bound.max_price_cents == 1_000_000


def test_search_ranks_by_profile_and_inventory_filters(catalog: Catalog) -> None:
    profile = catalog.user_profile("user_budget")
    ranked = catalog.search(
        profile=profile,
        categories=[],
        min_price_cents=0,
        max_price_cents=1_000_000,
        limit=5,
    )
    available = catalog.inventory(["P015", "P003", "P003"])

    assert ranked[0].category == "配件"
    assert [product.product_id for product in available] == ["P003"]

    with pytest.raises(CatalogError, match="unknown_inventory_product"):
        catalog.inventory(["UNKNOWN"])


def test_knowledge_rejects_an_empty_query(catalog: Catalog) -> None:
    with pytest.raises(CatalogError, match="empty_knowledge_query"):
        catalog.retrieve_knowledge(query=" ", categories=[], product_ids=[], limit=3)


def test_finalize_uses_database_truth_and_sanitizes_copy(catalog: Catalog) -> None:
    request = RecommendationRequest(
        user_id="user_active",
        num_items=1,
        context=UserContext(preferred_categories=["耳机"]),
    )
    profile = catalog.user_profile(request.user_id, request.context)
    result = catalog.finalize(
        [
            RecommendationDraftItem(
                product_id="P003",
                reason="这是最好的选择",
                marketing_copy="100%最好",
            )
        ],
        request,
        profile,
    )[0]
    truth = next(
        product for product in catalog.products if product.product_id == "P003"
    )

    assert result.price_cents == truth.price_cents
    assert result.stock == 1000
    assert "最好" not in result.reason + result.marketing_copy


def test_finalize_rejects_unknown_product(catalog: Catalog) -> None:
    profile = catalog.user_profile("user_active")
    draft = [
        RecommendationDraftItem(
            product_id="UNKNOWN", reason="不存在", marketing_copy="不存在"
        )
    ]

    with pytest.raises(CatalogError, match="unknown_recommended_product"):
        catalog.finalize(
            draft,
            RecommendationRequest(user_id="user_active"),
            profile,
        )


def test_finalize_rejects_duplicate_product_instead_of_dropping_it(
    catalog: Catalog,
) -> None:
    profile = catalog.user_profile("user_active")
    item = RecommendationDraftItem(
        product_id="P003", reason="适合通勤", marketing_copy="可以看看"
    )

    with pytest.raises(CatalogError, match="duplicate_recommended_product"):
        catalog.finalize(
            [item, item],
            RecommendationRequest(user_id="user_active"),
            profile,
        )


def test_agent_draft_requires_the_payload_for_its_action() -> None:
    with pytest.raises(ValidationError, match="clarify_question_required"):
        AgentDraft(action="clarify")

    with pytest.raises(ValidationError, match="recommendations_required"):
        AgentDraft(action="recommend")


def test_profile_updates_only_with_explicit_categories(catalog: Catalog) -> None:
    before = catalog.user_profile("user_active").preferred_categories
    catalog.update_user_profile_after_success("user_active", [])
    assert catalog.user_profile("user_active").preferred_categories == before

    catalog.update_user_profile_after_success("user_active", ["耳机", "耳机"])
    assert catalog.user_profile("user_active").preferred_categories == ["耳机"]

    current_request = catalog.user_profile(
        "user_active", UserContext(preferred_categories=["运动"])
    )
    assert current_request.preferred_categories == ["运动"]
