from __future__ import annotations

import logging

import pytest
from starlette.testclient import TestClient

from chatty.agent import RecommendationFailure, RecommendationService
from chatty.app import create_app
from chatty.catalog import Catalog
from chatty.experiments import ExperimentMetrics
from chatty.models import RecommendationRequest
from tests.test_agent import ScriptedModel, ToolStep, successful_script


def test_model_failure_maps_to_502(caplog) -> None:
    caplog.set_level(logging.ERROR, logger="chatty.agent")
    catalog = Catalog()
    metrics = ExperimentMetrics()
    service = RecommendationService(
        catalog,
        metrics,
        model=ScriptedModel([]),
        model_id="failing-scripted-model",
    )
    app = create_app(catalog=catalog, metrics=metrics, service=service)

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
    service = RecommendationService(
        Catalog(),
        ExperimentMetrics(),
        model=ScriptedModel(script),
        model_id="scripted-model",
    )

    try:
        with pytest.raises(RecommendationFailure, match="knowledge_not_retrieved"):
            await service.recommend(RecommendationRequest(user_id="user_active"))
    finally:
        await service.close()
