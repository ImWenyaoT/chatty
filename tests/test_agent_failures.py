from __future__ import annotations

import logging

import pytest
from starlette.testclient import TestClient

import chatty.agent
from chatty.agent import RecommendationError, Recommender
from chatty.app import create_app
from chatty.catalog import Catalog
from chatty.experiments import ExperimentMetrics
from chatty.models import RecommendationRequest
from tests.test_agent import ScriptedModel, ToolStep, successful_script


def test_model_failure_maps_to_502(caplog) -> None:
    caplog.set_level(logging.ERROR, logger="chatty.agent")
    catalog = Catalog()
    metrics = ExperimentMetrics()
    service = Recommender(
        catalog,
        metrics,
        model=ScriptedModel([]),
        model_id="failing-scripted-model",
    )
    app = create_app(recommender=service)

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/recommend",
            json={"user_id": "user_active"},
        )

    assert response.status_code == 502
    assert response.json()["detail"] == "recommendation_failed"
    assert "Unexpected recommendation failure" in caplog.text


@pytest.mark.asyncio
async def test_empty_rag_evidence_is_rejected() -> None:
    script = successful_script()
    script[3] = ToolStep(
        "call-4",
        "retrieve_knowledge",
        {
            "query": "不存在的知识关键词",
            "categories": [],
            "product_ids": [],
            "limit": 3,
        },
    )
    service = Recommender(
        Catalog(),
        ExperimentMetrics(),
        model=ScriptedModel(script),
        model_id="scripted-model",
    )

    try:
        with pytest.raises(RecommendationError, match="knowledge_not_retrieved"):
            await service.recommend(RecommendationRequest(user_id="user_active"))
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_missing_required_tool_is_rejected() -> None:
    script = successful_script()
    del script[0]
    service = Recommender(
        Catalog(),
        ExperimentMetrics(),
        model=ScriptedModel(script),
        model_id="scripted-model",
    )

    try:
        with pytest.raises(RecommendationError, match="required_tools_not_used"):
            await service.recommend(RecommendationRequest(user_id="user_active"))
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_tools_must_run_in_order() -> None:
    script = successful_script()
    script[0], script[1] = script[1], script[0]
    service = Recommender(
        Catalog(),
        ExperimentMetrics(),
        model=ScriptedModel(script),
        model_id="scripted-model",
    )

    try:
        with pytest.raises(RecommendationError, match="required_tools_not_used"):
            await service.recommend(RecommendationRequest(user_id="user_active"))
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_marketing_strategy_must_match_profile() -> None:
    script = successful_script()
    script[4] = ToolStep(
        "call-5",
        "get_marketing_strategy",
        {"segment": "new_user"},
    )
    service = Recommender(
        Catalog(),
        ExperimentMetrics(),
        model=ScriptedModel(script),
        model_id="scripted-model",
    )

    try:
        with pytest.raises(RecommendationError, match="required_tools_not_used"):
            await service.recommend(RecommendationRequest(user_id="user_active"))
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_response_construction_failure_is_not_counted_as_success(monkeypatch) -> None:
    metrics = ExperimentMetrics()
    service = Recommender(
        Catalog(),
        metrics,
        model=ScriptedModel(successful_script()),
        model_id="scripted-model",
    )

    def fail_response(**_kwargs):
        raise RuntimeError("response construction failed")

    monkeypatch.setattr(chatty.agent, "RecommendationResponse", fail_response)
    try:
        with pytest.raises(RecommendationError, match="recommendation_failed"):
            await service.recommend(RecommendationRequest(user_id="user_active"))
    finally:
        await service.close()

    snapshot = metrics.metrics_snapshot()
    assert snapshot["successes"] == 0
    assert snapshot["failures"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("script_index", "replacement", "failure"),
    [
        (
            1,
            ToolStep(
                "call-2",
                "search_products",
                {
                    "categories": ["手机"],
                    "min_price_cents": 0,
                    "max_price_cents": 1_000_000,
                    "tags": [],
                    "limit": 5,
                },
            ),
            "product_not_recalled",
        ),
        (
            2,
            ToolStep("call-3", "check_inventory", {"product_ids": ["P004"]}),
            "inventory_not_checked",
        ),
        (
            3,
            ToolStep(
                "call-4",
                "retrieve_knowledge",
                {
                    "query": "降噪 耳机",
                    "categories": ["耳机"],
                    "product_ids": ["P004"],
                    "limit": 3,
                },
            ),
            "product_not_grounded",
        ),
    ],
)
async def test_recommendation_requires_product_evidence(
    script_index: int,
    replacement: ToolStep,
    failure: str,
) -> None:
    script = successful_script()
    script[script_index] = replacement
    service = Recommender(
        Catalog(),
        ExperimentMetrics(),
        model=ScriptedModel(script),
        model_id="scripted-model",
    )

    try:
        with pytest.raises(RecommendationError, match=failure):
            await service.recommend(RecommendationRequest(user_id="user_active"))
    finally:
        await service.close()
