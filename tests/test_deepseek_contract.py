"""真实 DeepSeek 契约测试（specs/runtime-eval.md §8，7 个用例）。

全部标记 `@pytest.mark.deepseek`：默认 `uv run pytest` 经 addopts `-m 'not deepseek'`
跳过，只有 `pnpm test:deepseek`（= `uv run pytest -m deepseek -q`）显式运行。
OPENAI_API_KEY / OPENAI_BASE_URL 从仓库根 .env 读取（等价旧版 `node --env-file=.env`，
既有环境变量优先）。每个测试用独立临时目录中的 SQLite，并带 secret guard：
断言 key 明文不出现在任何输出/响应，也不落入临时目录下任何文件。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

import pytest
from agents import Agent, ModelSettings, RunConfig, Runner, function_tool
from agents.exceptions import ModelBehaviorError
from agents.tool_context import ToolContext
from fastapi.testclient import TestClient

from chatty.agent import model_from_env
from chatty.app import create_app
from chatty.env import load_root_env

pytestmark = pytest.mark.deepseek

REPO_ROOT = Path(__file__).resolve().parents[1]
BASE = "/api/chatty"

load_root_env()


def contract_client(tmp_path: Path) -> TestClient:
    if not os.getenv("OPENAI_API_KEY"):
        raise AssertionError("OPENAI_API_KEY is required")
    return TestClient(
        create_app(
            database_path=tmp_path / "contract.sqlite",
            knowledge_path=REPO_ROOT / "knowledge" / "records.jsonl",
            customer_identity=lambda: "contract-customer",
        )
    )


def assert_secret_not_exposed(tmp_path: Path, response_text: str) -> None:
    secret = os.environ["OPENAI_API_KEY"]
    if secret in response_text:
        raise AssertionError("OPENAI_API_KEY was exposed in the contract response")
    for path in tmp_path.rglob("*"):
        if path.is_file() and secret.encode() in path.read_bytes():
            raise AssertionError("OPENAI_API_KEY was persisted by the contract run")


def test_real_deepseek_completes_a_no_tool_run(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with contract_client(tmp_path) as client:
        response = client.post(f"{BASE}/runs", json={"message": "请只回复 OK，不要调用 Tool"})

    assert response.status_code == 200
    body = response.json()
    assert body["customer_id"] == "contract-customer"
    assert body["status"] == "responded"
    assert body["reply"]
    assert body["knowledge_search_results"] == []
    assert body["memory_events"] == []
    captured = capsys.readouterr()
    assert_secret_not_exposed(tmp_path, response.text + captured.out + captured.err)


def test_real_deepseek_uses_one_knowledge_tool_with_source_and_local_trace(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with contract_client(tmp_path) as client:
        response = client.post(
            f"{BASE}/runs",
            json={"message": "租期从哪一天开始？请查询店铺知识并标注来源。"},
        )
        trace = client.get(f"{BASE}/traces/{response.json()['trace_id']}")

    assert response.status_code == 200
    body = response.json()
    assert body["knowledge_search_results"]
    assert any(item["source"] in body["reply"] for item in body["knowledge_search_results"])
    assert trace.status_code == 200
    assert trace.json()["status"] == "completed"
    assert "function" in trace.json()["span_types"]
    assert trace.json()["knowledge_sources"]
    captured = capsys.readouterr()
    assert_secret_not_exposed(tmp_path, response.text + trace.text + captured.out + captured.err)


def test_real_deepseek_can_use_consecutive_tools_for_one_verified_order(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with contract_client(tmp_path) as client:
        response = client.post(
            f"{BASE}/runs",
            json={
                "message": (
                    "请先检查 SUIT-001 的 L 码在 2026-08-01 至 2026-08-03 "
                    "是否可租；若可租，立即创建 1 件、760 元、送到上海市静安区、"
                    "风险信息为无的订单。这个任务不需要知识搜索，只使用库存和订单 Tool。"
                )
            },
        )
        orders = client.get(f"{BASE}/orders")
        assert response.status_code == 200, response.text
        trace = client.get(f"{BASE}/traces/{response.json()['trace_id']}")

    assert response.json()["business_outcome"] == "verified"
    assert len(orders.json()) == 1
    function_spans = [span for span in trace.json()["spans"] if span["span_type"] == "function"]
    assert len(function_spans) >= 2
    captured = capsys.readouterr()
    assert_secret_not_exposed(
        tmp_path, response.text + orders.text + trace.text + captured.out + captured.err
    )


def test_real_deepseek_sqlite_session_supplies_previous_context(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with contract_client(tmp_path) as client:
        first = client.post(f"{BASE}/runs", json={"message": "我叫小林，请确认收到。"})
        second = client.post(
            f"{BASE}/runs",
            json={"message": "我刚才说我叫什么？", "session_id": first.json()["session_id"]},
        )

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["session_id"] == first.json()["session_id"]
    assert "小林" in second.json()["reply"]
    captured = capsys.readouterr()
    assert_secret_not_exposed(tmp_path, first.text + second.text + captured.out + captured.err)


def test_real_deepseek_missing_tool_parameters_cannot_create_an_order(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with contract_client(tmp_path) as client:
        response = client.post(
            f"{BASE}/runs",
            json={"message": "立即帮我创建一件 SUIT-001 的租赁订单，但我不提供尺码和日期。"},
        )
        orders = client.get(f"{BASE}/orders")

    assert response.status_code == 200
    assert orders.json() == []
    assert response.json()["business_outcome"] != "verified"
    captured = capsys.readouterr()
    assert_secret_not_exposed(tmp_path, response.text + orders.text + captured.out + captured.err)


async def test_real_deepseek_produces_valid_strict_tool_arguments(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    if not os.getenv("OPENAI_API_KEY"):
        raise AssertionError("OPENAI_API_KEY is required")
    calls: list[str] = []

    @function_tool(use_docstring_info=False, failure_error_function=None)
    def record_size(size: Literal["L"]) -> str:
        calls.append(size)
        return "recorded"

    model, _, client = model_from_env()
    try:
        agent = Agent(
            name="Tool parameter contract",
            instructions="必须调用 record_size，使用客户明确提供的尺码；Tool 成功后简短回答。",
            model=model,
            model_settings=ModelSettings(extra_body={"thinking": {"type": "disabled"}}),
            tools=[record_size],
        )
        result = await Runner.run(
            agent, "尺码是 L，请记录。", run_config=RunConfig(tracing_disabled=True)
        )
    finally:
        await client.close()

    assert calls == ["L"]
    captured = capsys.readouterr()
    assert_secret_not_exposed(
        tmp_path, str(result.final_output) + captured.out + captured.err
    )


async def test_local_schema_rejects_invalid_tool_arguments() -> None:
    """§8.7：不联网——直调 invoke 入口，pydantic literal_error 拒绝，工具体未执行。"""
    calls: list[str] = []

    @function_tool(use_docstring_info=False, failure_error_function=None)
    def record_size(size: Literal["L"]) -> str:
        calls.append(size)
        return "recorded"

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
    assert calls == []
