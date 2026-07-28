from __future__ import annotations

import logging

import pytest

import chatty.agent
from chatty import config
from chatty.agent import RecommendationError, Recommender
from chatty.catalog import Catalog
from chatty.experiments import ExperimentMetrics
from chatty.models import RecommendationRequest
from tests.test_agent import ScriptedModel, ToolStep, successful_script


@pytest.mark.asyncio
async def test_unexpected_failure_is_not_retriable(caplog) -> None:
    """未预期的故障要暴露成不可重试的失败，且留下可定位的日志。"""
    caplog.set_level(logging.ERROR, logger="chatty.agent")
    service = Recommender(
        Catalog(),
        ExperimentMetrics(),
        model=ScriptedModel([]),
        model_id="failing-scripted-model",
    )
    try:
        with pytest.raises(RecommendationError) as error:
            await service.recommend(RecommendationRequest(user_id="user_active"))
    finally:
        await service.close()

    assert error.value.code == "recommendation_failed"
    assert error.value.retriable is False  # 原样重试没有意义
    assert "Unexpected recommendation failure" in caplog.text


@pytest.mark.asyncio
async def test_missing_model_key_is_retriable(monkeypatch) -> None:
    """缺配置属于环境问题：补上密钥后同样的请求就能成功，因此标记为可重试。"""
    monkeypatch.setattr(config, "load_root_env", lambda: None)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    service = Recommender(Catalog(), ExperimentMetrics())
    try:
        with pytest.raises(RecommendationError) as error:
            await service.recommend(RecommendationRequest(user_id="user_active"))
    finally:
        await service.close()

    assert error.value.code == "llm_not_configured"
    assert error.value.retriable is True


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
            # 检索的是平板知识，推荐的却是耳机 P003——命中的文档既没有绑定 P003，
            # 也不属于耳机类目，因此 P003 拿不到任何依据。
            # （注意不能用"检索耳机但只传 P004"来构造：命中的耳机类目通用文档
            #   会覆盖整个耳机类目，P003 同样有依据，这是修正后的正确语义。）
            3,
            ToolStep(
                "call-4",
                "retrieve_knowledge",
                {
                    "query": "平板 学习 办公",
                    "categories": ["平板"],
                    "product_ids": ["P005"],
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
