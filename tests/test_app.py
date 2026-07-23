from __future__ import annotations

from starlette.testclient import TestClient

from chatty import config
from chatty.agent import Recommender
from chatty.app import create_app
from chatty.catalog import Catalog
from chatty.experiments import ExperimentMetrics
from tests.test_agent import ScriptedModel, successful_script


def test_health_does_not_require_model_key() -> None:
    app = create_app()
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["product_count"] == 20
    assert response.json()["knowledge_count"] == 12


def test_recommendation_api_and_openapi() -> None:
    catalog = Catalog()
    metrics = ExperimentMetrics()
    service = Recommender(
        catalog,
        metrics,
        model=ScriptedModel(successful_script()),
        model_id="scripted-model",
    )
    app = create_app(recommender=service)
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/recommend",
            json={
                "user_id": "user_active",
                "scene": "homepage",
                "num_items": 1,
                "context": {"preferred_categories": ["耳机"]},
            },
        )
        openapi = client.get("/openapi.json")
    assert response.status_code == 200
    assert response.json()["products"][0]["product_id"] == "P003"
    assert "/api/v1/recommend" in openapi.json()["paths"]


def test_native_request_validation() -> None:
    with TestClient(create_app()) as client:
        response = client.post(
            "/api/v1/recommend",
            json={"user_id": "", "scene": "unknown", "num_items": 99},
        )
    assert response.status_code == 422


def test_missing_model_key_maps_to_503(monkeypatch) -> None:
    monkeypatch.setattr(config, "load_root_env", lambda: None)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    catalog = Catalog()
    metrics = ExperimentMetrics()
    app = create_app(recommender=Recommender(catalog, metrics))
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/recommend",
            json={"user_id": "user_active"},
        )
    assert response.status_code == 503
    assert response.json()["detail"] == "llm_not_configured"


def test_experiment_outcome_and_metrics_endpoints() -> None:
    with TestClient(create_app()) as client:
        experiment = client.get("/api/v1/experiments")
        outcome = client.post(
            "/api/v1/outcomes",
            json={"user_id": "user_active", "success": True},
        )
        metrics = client.get("/api/v1/metrics")
    assert experiment.status_code == 200
    assert outcome.status_code == 200
    assert outcome.json()["status"] == "recorded"
    assert metrics.json()["requests"] == 0
