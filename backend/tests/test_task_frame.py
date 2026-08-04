import json
from types import SimpleNamespace
from typing import cast

import pytest
from agents.usage import Usage
from pydantic import ValidationError

from app.agent import Chatty, ChattyContext
from app.agent.evidence import RecommendationEvidence
from app.agent.executor import prepare_task_context
from app.agent.framing import (
    TaskFrameParseError,
    TaskFrameWire,
    build_task_frame_agent,
    describe_task_frame,
    parse_task_frame,
    parse_task_frame_wire_output,
)
from app.data.catalog import Catalog
from app.data.database import DATA_DIR
from app.data.models import ClarifyReply, KnowledgeReply, ProductNeed, TaskFrame
from app.model_provider import ResponsesModelProvider
from app.settings import Settings


@pytest.mark.asyncio
async def test_task_frame_agent_declares_structured_output() -> None:
    provider = ResponsesModelProvider(Settings(api_key="test-key"))
    try:
        agent = build_task_frame_agent(provider, ["耳机"])
    finally:
        await provider.close()

    assert agent.output_type is TaskFrameWire
    schema_text = str(TaskFrameWire.model_json_schema())
    assert "anyOf" not in schema_text
    assert "$ref" not in schema_text


def test_product_request_becomes_a_product_need() -> None:
    frame = parse_task_frame(
        TaskFrameWire(
            product_requested=True,
            category=["耳机"],
            min_yuan=[],
            max_yuan=[200],
            knowledge_query=[],
        ),
        ["耳机"],
    )

    assert frame.product_need == ProductNeed(
        category="耳机",
        min_yuan=None,
        max_yuan=200,
    )
    assert frame.knowledge_query is None
    assert describe_task_frame(frame) == "耳机 · ≤200 元"


def test_deepseek_properties_wrapper_is_recovered_deterministically() -> None:
    wire = parse_task_frame_wire_output(
        json.dumps(
            {
                "properties": {
                    "product_requested": False,
                    "category": [],
                    "min_yuan": [],
                    "max_yuan": [],
                    "knowledge_query": ["退换货政策"],
                }
            },
            ensure_ascii=False,
        )
    )

    assert wire.knowledge_query == ["退换货政策"]


def test_knowledge_request_does_not_require_a_product_need() -> None:
    frame = parse_task_frame(
        TaskFrameWire(
            product_requested=False,
            category=[],
            min_yuan=[],
            max_yuan=[],
            knowledge_query=["退换货政策"],
        ),
        ["耳机"],
    )

    assert frame.product_need is None
    assert frame.knowledge_query == "退换货政策"
    assert describe_task_frame(frame) == "知识 · 退换货政策"


def test_mixed_request_preserves_both_context_requirements() -> None:
    frame = parse_task_frame(
        TaskFrameWire(
            product_requested=True,
            category=["耳机"],
            min_yuan=[],
            max_yuan=[200],
            knowledge_query=["七天无理由退货条件"],
        ),
        ["耳机"],
    )

    assert frame.product_need is not None
    assert frame.product_need.category == "耳机"
    assert frame.product_need.max_yuan == 200
    assert frame.knowledge_query == "七天无理由退货条件"


def test_empty_task_frame_is_rejected_by_the_contract() -> None:
    with pytest.raises(ValidationError):
        TaskFrame(product_need=None, knowledge_query=None)


def test_invalid_product_category_is_an_explicit_failure() -> None:
    with pytest.raises(TaskFrameParseError, match="invalid_product_category"):
        parse_task_frame(
            TaskFrameWire(
                product_requested=True,
                category=["手机"],
                min_yuan=[],
                max_yuan=[],
                knowledge_query=[],
            ),
            ["耳机"],
        )


def test_knowledge_only_task_never_enters_the_product_pipeline() -> None:
    class KnowledgeOnlyCatalog:
        def user_profile(self, *args: object, **kwargs: object) -> None:
            pytest.fail("knowledge-only task must not load a product profile")

        def search(self, *args: object, **kwargs: object) -> None:
            pytest.fail("knowledge-only task must not search products")

        def inventory(self, *args: object, **kwargs: object) -> None:
            pytest.fail("knowledge-only task must not check inventory")

        def retrieve_knowledge(self, *args: object, **kwargs: object) -> None:
            pytest.fail("knowledge retrieval belongs to the Agent tool loop")

    catalog = KnowledgeOnlyCatalog()
    context = prepare_task_context(
        TaskFrame(product_need=None, knowledge_query="退换货政策"),
        "user_active",
        cast(Catalog, catalog),
        RecommendationEvidence(),
    )

    assert context.recommendation is None
    assert context.frame.knowledge_query == "退换货政策"


@pytest.mark.asyncio
async def test_task_framing_receives_the_full_clarification_conversation(
    tmp_path, monkeypatch
) -> None:
    catalog = Catalog(tmp_path / "chatty.db", DATA_DIR)
    provider = ResponsesModelProvider(Settings(api_key="test-key"))
    chatty = Chatty(catalog, provider)
    parser_inputs: list[str] = []

    async def fake_runner_run(agent, model_input, **kwargs):
        parser_inputs.append(model_input)
        return SimpleNamespace(
            final_output=TaskFrameWire(
                product_requested=True,
                category=["耳机"],
                min_yuan=[],
                max_yuan=[200],
                knowledge_query=[],
            ),
            context_wrapper=SimpleNamespace(
                usage=Usage(
                    requests=1,
                    input_tokens=100,
                    output_tokens=20,
                    total_tokens=120,
                )
            ),
        )

    async def fake_respond(task_context, evidence, user_text, history):
        assert task_context.frame.product_need is not None
        assert task_context.frame.product_need.category == "耳机"
        assert task_context.frame.product_need.max_yuan == 200
        assert user_text == "预算 200 元"
        evidence.usage.add(
            Usage(
                requests=2,
                input_tokens=300,
                output_tokens=40,
                total_tokens=340,
            )
        )
        return ClarifyReply(question="还需要什么？")

    monkeypatch.setattr("app.agent.chatty.Runner.run", fake_runner_run)
    monkeypatch.setattr(chatty.executor, "respond", fake_respond)

    try:
        turn = await chatty.run(
            "user_active",
            "预算 200 元",
            ChattyContext(pending_user_messages=["给我推荐耳机"], turns=1),
        )
    finally:
        await provider.close()
        catalog.close()

    assert len(parser_inputs) == 1
    assert "给我推荐耳机" in parser_inputs[0]
    assert "预算 200 元" in parser_inputs[0]
    assert turn.context.pending_user_messages == ["给我推荐耳机", "预算 200 元"]
    assert turn.usage.requests == 3
    assert turn.usage.input_tokens == 400
    assert turn.usage.output_tokens == 60
    assert turn.usage.total_tokens == 460
    assert turn.latency_ms >= 0


@pytest.mark.asyncio
async def test_completed_task_does_not_leak_into_the_next_task(
    tmp_path, monkeypatch
) -> None:
    catalog = Catalog(tmp_path / "chatty.db", DATA_DIR)
    provider = ResponsesModelProvider(Settings(api_key="test-key"))
    chatty = Chatty(catalog, provider)
    parser_inputs: list[str] = []

    async def fake_runner_run(agent, model_input, **kwargs):
        parser_inputs.append(model_input)
        return SimpleNamespace(
            final_output=TaskFrameWire(
                product_requested=False,
                category=[],
                min_yuan=[],
                max_yuan=[],
                knowledge_query=[model_input],
            ),
            context_wrapper=SimpleNamespace(usage=Usage()),
        )

    async def fake_respond(task_context, evidence, user_text, history):
        return KnowledgeReply(answer=user_text)

    monkeypatch.setattr("app.agent.chatty.Runner.run", fake_runner_run)
    monkeypatch.setattr(chatty.executor, "respond", fake_respond)

    try:
        first = await chatty.run("user_active", "退货政策", ChattyContext())
        await chatty.run("user_active", "快递公司", first.context)
    finally:
        await provider.close()
        catalog.close()

    assert parser_inputs == ["用户第1轮：退货政策", "用户第1轮：快递公司"]
    assert first.context.pending_user_messages == []
    assert first.context.history == []
