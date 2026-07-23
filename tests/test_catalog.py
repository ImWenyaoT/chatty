from __future__ import annotations

import json

import pytest

from chatty import config
from chatty.catalog import Catalog, CatalogError
from chatty.models import (
    RecommendationDraft,
    RecommendationDraftItem,
    RecommendationRequest,
    UserContext,
)


@pytest.fixture(scope="module")
def catalog() -> Catalog:
    return Catalog()


def test_demo_data_has_twenty_sale_products(catalog: Catalog) -> None:
    assert len(catalog.products) == 20
    assert all(product.price_cents > 0 and product.stock >= 0 for product in catalog.products)
    assert len(catalog.profiles) == 5
    assert len(catalog.templates) == 5

    raw_suit = next(
        json.loads(line)
        for line in (config.DATA_DIR / "products.jsonl").read_text().splitlines()
        if '"SUIT-001"' in line
    )
    assert raw_suit["stock"] == 4
    assert not {"rental", "renewal_price", "start_date", "end_date"} & raw_suit.keys()


def test_profile_context_overrides_demo_profile(catalog: Catalog) -> None:
    profile = catalog.user_profile(
        "user_active",
        UserContext(
            preferred_categories=["运动"],
            min_price_cents=10_000,
            max_price_cents=70_000,
        ),
    )
    assert profile.segment == "active"
    assert profile.preferred_categories == ["运动"]
    assert profile.min_price_cents == 10_000
    assert profile.max_price_cents == 70_000


def test_personalized_group_changes_ranking(catalog: Catalog) -> None:
    profile = catalog.user_profile("user_budget", UserContext())
    common = {
        "profile": profile,
        "categories": [],
        "min_price_cents": 0,
        "max_price_cents": 1_000_000,
        "tags": [],
        "limit": 5,
    }
    control = catalog.search(group="control", **common)
    personalized = catalog.search(group="treatment_personalized", **common)
    assert control[0].product_id == "P001"
    assert personalized[0].category == "配件"


def test_inventory_and_final_output_are_canonical(catalog: Catalog) -> None:
    assert [item.product_id for item in catalog.inventory(["P015", "P003"])] == ["P003"]

    request = RecommendationRequest(user_id="user_active", num_items=1)
    profile = catalog.user_profile(request.user_id, request.context)
    draft = RecommendationDraft(
        recommendations=[
            RecommendationDraftItem(
                product_id="P003",
                reason="这是最好的降噪选择",
                marketing_copy="这是100%最好的耳机",
            )
        ]
    )
    result = catalog.finalize(draft, request, profile, "treatment_personalized")
    assert result[0].price_cents == next(
        product.price_cents for product in catalog.products if product.product_id == "P003"
    )
    assert result[0].stock == 1000
    assert "100%" not in result[0].marketing_copy
    assert "最好" not in result[0].marketing_copy
    assert "最好" not in result[0].reason


def test_unknown_recommended_product_is_rejected(catalog: Catalog) -> None:
    request = RecommendationRequest(user_id="user_active")
    profile = catalog.user_profile(request.user_id, request.context)
    draft = RecommendationDraft(
        recommendations=[
            RecommendationDraftItem(
                product_id="UNKNOWN",
                reason="不存在",
                marketing_copy="不存在",
            )
        ]
    )
    with pytest.raises(CatalogError, match="unknown_recommended_product"):
        catalog.finalize(draft, request, profile, "control")


def test_finalize_reads_current_inventory(tmp_path) -> None:
    catalog = Catalog(database_path=tmp_path / "chatty.db")
    request = RecommendationRequest(user_id="user_active", num_items=1)
    profile = catalog.user_profile(request.user_id, request.context)
    draft = RecommendationDraft(
        recommendations=[
            RecommendationDraftItem(
                product_id="P003",
                reason="降噪耳机",
                marketing_copy="适合通勤",
            )
        ]
    )
    try:
        catalog.database.connection.execute(
            "UPDATE products SET stock = 0 WHERE product_id = 'P003'"
        )
        catalog.database.connection.commit()

        with pytest.raises(CatalogError, match="no_available_recommendations"):
            catalog.finalize(draft, request, profile, "control")
    finally:
        catalog.close()


def test_finalize_enforces_profile_price_range(catalog: Catalog) -> None:
    request = RecommendationRequest(
        user_id="user_active",
        num_items=1,
        context=UserContext(max_price_cents=100_000),
    )
    profile = catalog.user_profile(request.user_id, request.context)
    draft = RecommendationDraft(
        recommendations=[
            RecommendationDraftItem(
                product_id="P003",
                reason="降噪耳机",
                marketing_copy="适合通勤",
            )
        ]
    )

    with pytest.raises(CatalogError, match="no_available_recommendations"):
        catalog.finalize(draft, request, profile, "control")


def test_invalid_tool_inputs_are_rejected_instead_of_corrected(catalog: Catalog) -> None:
    profile = catalog.user_profile("user_active", UserContext())
    with pytest.raises(CatalogError, match="invalid_product_search_price_range"):
        catalog.search(
            profile=profile,
            group="control",
            categories=[],
            min_price_cents=100,
            max_price_cents=10,
            tags=[],
            limit=5,
        )
    with pytest.raises(CatalogError, match="invalid_product_search_limit"):
        catalog.search(
            profile=profile,
            group="control",
            categories=[],
            min_price_cents=0,
            max_price_cents=100,
            tags=[],
            limit=0,
        )
    with pytest.raises(CatalogError, match="unknown_marketing_segment"):
        catalog.marketing_strategy("unknown")
