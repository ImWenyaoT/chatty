import os
from pathlib import Path
from typing import Literal

import pytest
from agents import Agent, ModelSettings, Runner, function_tool
from agents.exceptions import ModelBehaviorError
from agents.tool_context import ToolContext
from fastapi.testclient import TestClient

from chatty.agent import model_from_env
from chatty.app import create_app


def contract_client(tmp_path: Path) -> TestClient:
    if not os.getenv("OPENAI_API_KEY"):
        raise AssertionError("OPENAI_API_KEY is required for --run-deepseek")
    return TestClient(create_app(database_path=tmp_path / "contract.sqlite"))


def assert_secret_not_exposed(tmp_path: Path, response_text: str) -> None:
    secret = os.environ["OPENAI_API_KEY"]
    if secret in response_text:
        raise AssertionError("OPENAI_API_KEY was exposed in the contract response")
    for path in tmp_path.rglob("*"):
        if path.is_file() and secret.encode() in path.read_bytes():
            raise AssertionError("OPENAI_API_KEY was persisted by the contract run")


def test_real_deepseek_completes_a_no_tool_run(tmp_path: Path) -> None:
    with contract_client(tmp_path) as client:
        response = client.post("/runs", json={"message": "请只回复 OK，不要调用 Tool"})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "responded"
    assert body["reply"]
    assert body["knowledge_search_results"] == []
    assert body["memory_events"] == []


def test_real_deepseek_uses_one_knowledge_tool_with_source_and_local_trace(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    with contract_client(tmp_path) as client:
        response = client.post(
            "/runs",
            json={"message": "租期从哪一天开始？请查询店铺知识并标注来源。"},
        )
        trace = client.get(f"/traces/{response.json()['trace_id']}")

    assert response.status_code == 200
    assert response.json()["knowledge_search_results"]
    assert any(
        item["source"] in response.json()["reply"]
        for item in response.json()["knowledge_search_results"]
    )
    assert trace.status_code == 200
    assert "function" in trace.json()["span_types"]
    assert trace.json()["knowledge_sources"]
    captured = capsys.readouterr()
    assert_secret_not_exposed(tmp_path, response.text + trace.text + captured.out + captured.err)


def test_real_deepseek_can_use_consecutive_tools_for_one_verified_order(
    tmp_path: Path,
) -> None:
    with contract_client(tmp_path) as client:
        response = client.post(
            "/runs",
            json={
                "message": (
                    "请先检查 SUIT-001 的 L 码在 2026-08-01 至 2026-08-03 "
                    "是否可租；若可租，立即创建 1 件、760 元、送到上海市静安区的订单。"
                )
            },
        )
        orders = client.get("/orders")
        trace = client.get(f"/traces/{response.json()['trace_id']}")

    assert response.status_code == 200
    assert response.json()["business_outcome"] == "verified"
    assert len(orders.json()) == 1
    function_spans = [span for span in trace.json()["spans"] if span["span_type"] == "function"]
    assert len(function_spans) >= 2


def test_real_deepseek_sqlite_session_supplies_previous_context(tmp_path: Path) -> None:
    with contract_client(tmp_path) as client:
        first = client.post("/runs", json={"message": "我叫小林，请确认收到。"})
        second = client.post(
            "/runs",
            json={"message": "我刚才说我叫什么？", "session_id": first.json()["session_id"]},
        )

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["session_id"] == first.json()["session_id"]
    assert "小林" in second.json()["reply"]


def test_real_deepseek_missing_tool_parameters_cannot_create_an_order(
    tmp_path: Path,
) -> None:
    with contract_client(tmp_path) as client:
        response = client.post(
            "/runs",
            json={"message": "立即帮我创建一件 SUIT-001 的租赁订单，但我不提供尺码和日期。"},
        )
        orders = client.get("/orders")

    assert response.status_code == 200
    assert orders.json() == []
    assert response.json()["business_outcome"] != "verified"


@pytest.mark.asyncio
async def test_real_deepseek_tool_contract_and_local_schema_reject_invalid_arguments() -> None:
    calls: list[str] = []

    @function_tool(use_docstring_info=False, failure_error_function=None)
    def record_size(size: Literal["L"]) -> str:
        calls.append(size)
        return "recorded"

    model, _ = model_from_env()
    agent = Agent(
        name="Tool parameter contract",
        instructions="必须调用 record_size，使用客户明确提供的尺码；Tool 成功后简短回答。",
        model=model,
        model_settings=ModelSettings(extra_body={"thinking": {"type": "disabled"}}),
        tools=[record_size],
    )

    await Runner.run(agent, "尺码是 L，请记录。")

    assert calls == ["L"]
    invalid_arguments = '{"size":"XXL"}'
    with pytest.raises(ModelBehaviorError, match="literal_error"):
        await record_size.on_invoke_tool(
            ToolContext(
                None,
                tool_name="record_size",
                tool_call_id="invalid-size-contract",
                tool_arguments=invalid_arguments,
            ),
            invalid_arguments,
        )
    assert calls == ["L"]
