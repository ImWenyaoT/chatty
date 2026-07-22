from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException

from chatty.agent import RecommendationFailure, RecommendationService
from chatty.catalog import Catalog
from chatty.experiments import ExperimentMetrics
from chatty.models import (
    ExperimentOutcomeRequest,
    RecommendationRequest,
    RecommendationResponse,
)


def create_app(
    *,
    catalog: Catalog | None = None,
    metrics: ExperimentMetrics | None = None,
    service: RecommendationService | None = None,
) -> FastAPI:
    if service is not None:
        if catalog is not None and catalog is not service.catalog:
            raise ValueError("service_catalog_mismatch")
        if metrics is not None and metrics is not service.metrics:
            raise ValueError("service_metrics_mismatch")
        resolved_catalog = service.catalog
        resolved_metrics = service.metrics
        resolved_service = service
    else:
        resolved_catalog = catalog or Catalog()
        resolved_metrics = metrics or ExperimentMetrics()
        resolved_service = RecommendationService(resolved_catalog, resolved_metrics)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        yield
        await resolved_service.close()

    app = FastAPI(
        title="Chatty Single-Agent E-Commerce Recommendation",
        description="一个 Agent 完成用户画像、商品推荐、库存校验、知识检索与营销文案。",
        version="0.1.0",
        lifespan=lifespan,
    )

    @app.get("/health")
    async def health() -> dict[str, str | int]:
        return {
            "status": "healthy",
            "model": resolved_service.model_id,
            "product_count": len(resolved_catalog.products),
            "knowledge_count": resolved_catalog.knowledge_count,
        }

    @app.post("/api/v1/recommend", response_model=RecommendationResponse)
    async def recommend(request: RecommendationRequest) -> RecommendationResponse:
        try:
            return await resolved_service.recommend(request)
        except RecommendationFailure as error:
            status_code = 503 if error.code == "llm_not_configured" else 502
            raise HTTPException(status_code=status_code, detail=error.code) from error

    @app.get("/api/v1/experiments")
    async def experiments() -> dict[str, Any]:
        return resolved_metrics.experiment_snapshot()

    @app.post("/api/v1/experiments/ranking_strategy/outcomes")
    async def record_outcome(payload: ExperimentOutcomeRequest) -> dict[str, str]:
        group = resolved_metrics.record_outcome(payload.user_id, payload.success)
        return {"status": "recorded", "experiment_group": group}

    @app.get("/api/v1/metrics")
    async def metrics_snapshot() -> dict[str, Any]:
        return resolved_metrics.metrics_snapshot()

    return app


app = create_app()
