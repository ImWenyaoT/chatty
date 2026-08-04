from types import SimpleNamespace
from typing import Any, cast

import pytest
from agents import RunContextWrapper
from agents.items import ModelResponse
from agents.run_config import CallModelData, ModelInputData
from agents.tool_guardrails import ToolInputGuardrailData
from agents.usage import Usage
from openai.types.responses import ResponseFunctionToolCall

from app.agent.evidence import RecommendationEvidence
from app.agent.tools import ChattyRunContext, get_marketing_strategy, retrieve_knowledge
from app.agent.workflow import (
    ChattyRunHooks,
    WorkflowStage,
    allowed_tools,
    append_agent_status,
    plan_tool_batch,
    render_agent_status,
    stage_for,
    stage_guardrail,
)
from app.data.models import UserProfile


def profile() -> UserProfile:
    return UserProfile(
        user_id="U001",
        segment="active",
        preferred_categories=["耳机"],
        min_price_cents=0,
        max_price_cents=20000,
        recent_views=[],
        recent_purchases=[],
    )


def test_support_tools_share_one_safe_parallel_stage() -> None:
    evidence = RecommendationEvidence(profile=profile())
    evidence.used_tools.extend(
        ["get_user_profile", "search_products", "check_inventory"]
    )

    batch = plan_tool_batch(
        evidence,
        [
            ("call_knowledge", "retrieve_knowledge"),
            ("call_strategy", "get_marketing_strategy"),
        ],
    )

    assert batch.stage is WorkflowStage.NEED_SUPPORT
    assert all(decision.allowed for decision in batch.decisions.values())


def test_agent_status_is_a_deterministic_projection_of_harness_state() -> None:
    evidence = RecommendationEvidence(profile=profile())
    evidence.used_tools.extend(
        ["get_user_profile", "search_products", "check_inventory"]
    )

    status = render_agent_status(evidence)

    assert status == (
        '<agent_status version="3">\n'
        "stage: need_support\n"
        "completed_steps: get_user_profile, search_products, check_inventory\n"
        "required_knowledge_scopes: none\n"
        "completed_knowledge_scopes: none\n"
        "allowed_next: retrieve_knowledge, get_marketing_strategy\n"
        "blocked_attempts: 0\n"
        "</agent_status>"
    )


@pytest.mark.asyncio
async def test_sdk_hook_freezes_batch_decisions_before_tool_guardrail() -> None:
    run_context = ChattyRunContext(
        request=cast(Any, SimpleNamespace()),
        catalog=cast(Any, SimpleNamespace()),
        evidence=RecommendationEvidence(
            profile=profile(),
            used_tools=["get_user_profile", "search_products", "check_inventory"],
        ),
    )
    wrapper = RunContextWrapper(run_context)
    response = ModelResponse(
        output=[
            ResponseFunctionToolCall(
                arguments="{}",
                call_id="call_knowledge_1",
                name="retrieve_knowledge",
                type="function_call",
            ),
            ResponseFunctionToolCall(
                arguments="{}",
                call_id="call_knowledge_2",
                name="retrieve_knowledge",
                type="function_call",
            ),
        ],
        usage=Usage(),
        response_id=None,
    )

    await ChattyRunHooks().on_llm_end(wrapper, cast(Any, SimpleNamespace()), response)

    tool_context = SimpleNamespace(
        context=run_context,
        tool_call_id="call_knowledge_2",
        tool_name="retrieve_knowledge",
    )
    result = await stage_guardrail.run(
        ToolInputGuardrailData(
            context=cast(Any, tool_context),
            agent=cast(Any, SimpleNamespace()),
        )
    )
    assert result.behavior["type"] == "reject_content"
    assert "duplicate_tool_in_batch" in result.behavior["message"]
    assert run_context.evidence.blocked_attempts == [
        "need_support:retrieve_knowledge:duplicate_tool_in_batch"
    ]


def test_agent_status_is_appended_without_rewriting_existing_context() -> None:
    run_context = ChattyRunContext(
        request=cast(Any, SimpleNamespace()),
        catalog=cast(Any, SimpleNamespace()),
        evidence=RecommendationEvidence(),
    )
    original: Any = [
        {
            "role": "user",
            "content": [{"type": "input_text", "text": "request"}],
        }
    ]

    filtered = append_agent_status(
        CallModelData(
            model_data=ModelInputData(input=original, instructions="fixed"),
            agent=cast(Any, SimpleNamespace()),
            context=run_context,
        )
    )

    assert filtered.input[:-1] == original
    assert filtered.instructions == "fixed"
    status_item = cast(Any, filtered.input[-1])
    assert status_item["role"] == "developer"
    assert "<agent_status" in status_item["content"][0]["text"]


def test_tools_do_not_ask_model_to_repeat_harness_owned_facts() -> None:
    assert get_marketing_strategy.params_json_schema["properties"] == {}
    assert set(retrieve_knowledge.params_json_schema["properties"]) == {
        "query",
        "limit",
        "scope",
    }
    limit_schema = retrieve_knowledge.params_json_schema["properties"]["limit"]
    assert limit_schema["minimum"] == 1
    assert limit_schema["maximum"] == 8


def test_knowledge_only_run_exposes_retrieval_without_marketing() -> None:
    evidence = RecommendationEvidence(
        required_support_tools=("retrieve_knowledge",),
    )

    assert allowed_tools(evidence) == ("retrieve_knowledge",)


def test_agent_can_refine_knowledge_query_after_first_result() -> None:
    evidence = RecommendationEvidence(
        required_support_tools=("retrieve_knowledge",),
        used_tools=["retrieve_knowledge"],
    )

    assert stage_for(evidence) is WorkflowStage.READY_TO_DRAFT
    assert allowed_tools(evidence) == ("retrieve_knowledge",)


def test_mixed_run_requires_both_knowledge_scopes() -> None:
    evidence = RecommendationEvidence(
        used_tools=["retrieve_knowledge", "get_marketing_strategy"],
        completed_knowledge_scopes={"general"},
        required_knowledge_scopes=("general", "product"),
    )

    assert stage_for(evidence) is WorkflowStage.NEED_SUPPORT
    assert allowed_tools(evidence) == ("retrieve_knowledge",)
    assert "required_knowledge_scopes: general, product" in render_agent_status(
        evidence
    )
    assert "completed_knowledge_scopes: general" in render_agent_status(evidence)
