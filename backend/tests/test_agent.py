from typing import Any, cast

import pytest
from agents import RunContextWrapper
from agents.usage import Usage

from app.agent.evidence import RecommendationEvidence
from app.agent.executor import (
    ChattyExecutor,
    RecommendationError,
    build_chatty_agent,
    build_draft_correction_agent,
    correct_invalid_draft,
    prepare_recommendation_context,
    prepare_task_context,
)
from app.agent.tools import ChattyRunContext
from app.data.catalog import Catalog
from app.data.models import (
    AgentDraft,
    ProductNeed,
    RecommendationRequest,
    TaskFrame,
    UserContext,
)
from app.model_provider import ResponsesModelProvider
from app.settings import Settings


def test_harness_prepares_deterministic_recommendation_context(tmp_path) -> None:
    catalog = Catalog(tmp_path / "chatty.db")
    evidence = RecommendationEvidence()
    try:
        context = prepare_recommendation_context(
            RecommendationRequest(
                user_id="user_active",
                context=UserContext(
                    preferred_categories=["耳机"],
                    max_price_cents=20_000,
                ),
            ),
            catalog,
            evidence,
        )
    finally:
        catalog.close()

    assert context.profile.user_id == "user_active"
    assert context.candidates == []
    assert context.inventory == []
    assert evidence.used_tools == [
        "get_user_profile",
        "search_products",
        "check_inventory",
    ]


@pytest.mark.asyncio
async def test_chatty_agent_declares_structured_output() -> None:
    provider = ResponsesModelProvider(Settings(api_key="test-key"))
    try:
        agent = build_chatty_agent(provider)
    finally:
        await provider.close()

    assert agent.output_type is AgentDraft
    assert [tool.name for tool in agent.tools] == [
        "retrieve_knowledge",
        "get_marketing_strategy",
    ]
    assert agent.model_settings.tool_choice == "required"


@pytest.mark.asyncio
async def test_draft_correction_agent_keeps_the_same_output_contract() -> None:
    provider = ResponsesModelProvider(Settings(api_key="test-key"))
    try:
        agent = build_draft_correction_agent(provider)
    finally:
        await provider.close()

    assert agent.tools == []
    assert agent.output_type is AgentDraft


@pytest.mark.asyncio
async def test_draft_correction_usage_is_included_in_the_parent_run(
    tmp_path, monkeypatch
) -> None:
    provider = ResponsesModelProvider(Settings(api_key="test-key"))
    catalog = Catalog(tmp_path / "chatty.db")
    context = RunContextWrapper(
        ChattyRunContext(
            request=None,
            catalog=catalog,
            evidence=RecommendationEvidence(),
        )
    )

    async def fake_run(*args, **kwargs):
        return type(
            "CorrectionResult",
            (),
            {
                "final_output": AgentDraft(action="answer", answer="已纠正"),
                "context_wrapper": RunContextWrapper(None),
            },
        )()

    correction = await fake_run()
    correction.context_wrapper.usage.add(
        Usage(requests=1, input_tokens=100, output_tokens=20, total_tokens=120)
    )

    async def return_correction(*args, **kwargs):
        return correction

    monkeypatch.setattr("app.agent.executor.Runner.run", return_correction)
    data = type(
        "ErrorInput",
        (),
        {
            "context": context,
            "run_data": type("RunData", (), {"raw_responses": []})(),
        },
    )()
    try:
        await correct_invalid_draft(cast(Any, data), provider)
    finally:
        await provider.close()
        catalog.close()

    assert context.usage.requests == 1
    assert context.usage.total_tokens == 120


@pytest.mark.asyncio
async def test_mixed_task_cannot_finish_as_a_knowledge_only_answer(
    tmp_path, monkeypatch
) -> None:
    provider = ResponsesModelProvider(Settings(api_key="test-key"))
    catalog = Catalog(tmp_path / "chatty.db")
    executor = ChattyExecutor(catalog, provider)
    evidence = RecommendationEvidence(general_knowledge_hits=1)
    task_context = prepare_task_context(
        TaskFrame(
            product_need=ProductNeed(category="耳机", max_yuan=300),
            knowledge_query="七天无理由退货条件",
        ),
        "user_active",
        catalog,
        evidence,
    )

    async def fake_run(*args, **kwargs):
        return type(
            "Result",
            (),
            {
                "final_output": AgentDraft(action="answer", answer="七天内可退货"),
                "context_wrapper": RunContextWrapper(None),
            },
        )()

    monkeypatch.setattr("app.agent.executor.Runner.run", fake_run)

    try:
        with pytest.raises(RecommendationError, match="invalid_draft"):
            await executor.respond(task_context, evidence, "推荐耳机并说明退货政策")
    finally:
        await provider.close()
        catalog.close()
