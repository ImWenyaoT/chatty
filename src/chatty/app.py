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
    service: RecommendationService | None = None,
) -> FastAPI:
    resolved_service = service or RecommendationService(Catalog(), ExperimentMetrics())

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
            "product_count": len(resolved_service.catalog.products),
            "knowledge_count": resolved_service.catalog.knowledge_count,
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
        return resolved_service.metrics.experiment_snapshot()

    @app.post("/api/v1/experiments/ranking_strategy/outcomes")
    async def record_outcome(payload: ExperimentOutcomeRequest) -> dict[str, str]:
        group = resolved_service.metrics.record_outcome(payload.user_id, payload.success)
        return {"status": "recorded", "experiment_group": group}

    @app.get("/api/v1/metrics")
    async def metrics_snapshot() -> dict[str, Any]:
        return resolved_service.metrics.metrics_snapshot()

    return app


app = create_app()
