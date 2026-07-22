"""ChattyRunModule.run 全流程测试（specs/runtime-eval.md §3–§5）。

用内联 ScriptedModel（EvalModel 同款 Model 接口，§9.5）确定性驱动 Agent Loop：
纯回复、知识引用、强制 handoff（空输出 / 缺来源 / max turns）、订单核验、
会话属主校验与 SQLiteSession 存储态。
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from agents import Model, ModelResponse, ModelSettings, ModelTracing, Usage
from agents.agent_output import AgentOutputSchemaBase
from agents.handoffs import Handoff
from agents.items import TResponseInputItem, TResponseStreamEvent
from agents.tool import Tool
from openai.types.responses import (
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
)

from chatty.agent import (
    AGENT_INSTRUCTIONS,
    DEFAULT_BASE_URL,
    DEFAULT_MODEL_ID,
    build_agent,
    model_from_env,
)
from chatty.harness import AgentRunResult, RunFailure
from chatty.run import ChattyRunModule
from chatty.runtime import NativeRuntime


@dataclass(frozen=True)
class ToolStep:
    call_id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class MessageStep:
    message_id: str
    text: str


class ScriptedModel(Model):
    """确定性脚本 Model（§7.4/§9.5 的 EvalModel 形态）：每次调用消费一条脚本。"""

    def __init__(self, script: Sequence[ToolStep | MessageStep]) -> None:
        self._script = iter(script)

    async def get_response(
        self,
        system_instructions: str | None,
        input: str | list[TResponseInputItem],
        model_settings: ModelSettings,
        tools: list[Tool],
        output_schema: AgentOutputSchemaBase | None,
        handoffs: list[Handoff],
        tracing: ModelTracing,
        *,
        previous_response_id: str | None,
        conversation_id: str | None,
        prompt: Any,
    ) -> ModelResponse:
        try:
            item = next(self._script)
        except StopIteration:
            raise RuntimeError("eval script exhausted") from None
        if isinstance(item, ToolStep):
            output: list[Any] = [
                ResponseFunctionToolCall(
                    arguments=json.dumps(item.arguments, ensure_ascii=False),
                    call_id=item.call_id,
                    name=item.name,
                    type="function_call",
                )
            ]
        else:
            output = [
                ResponseOutputMessage(
                    id=item.message_id,
                    content=[
                        ResponseOutputText(annotations=[], text=item.text, type="output_text")
                    ],
                    role="assistant",
                    status="completed",
                    type="message",
                )
            ]
        return ModelResponse(output=output, usage=Usage(), response_id=None)

    def stream_response(self, *args: Any, **kwargs: Any) -> AsyncIterator[TResponseStreamEvent]:
        raise NotImplementedError


KNOWLEDGE_SOURCE = "seller-policy://rental-period"


def write_knowledge(tmp_path: Path) -> Path:
    record = {
        "id": "policy-rental-period-1",
        "title": "租期计算",
        "summary": "租期从签收当天开始计算。",
        "body": "租期从客户签收当天开始计算，在途时间不计入租期。",
        "source": KNOWLEDGE_SOURCE,
        "tags": ["租赁", "租期"],
    }
    path = tmp_path / "records.jsonl"
    path.write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


@pytest.fixture
def runtime(tmp_path: Path) -> NativeRuntime:
    native_runtime = NativeRuntime(tmp_path / "chatty.sqlite")
    yield native_runtime
    native_runtime.close()


def test_runtime_closes_stores_in_documented_order(tmp_path: Path) -> None:
    """关闭顺序是 NativeRuntime 的对外约定（specs/stores.md §0.1），此前无处断言。

    commerce 必须最后关：knowledge 复用的正是它那个 Database 句柄（连同写事务锁），
    任何把 commerce 提前的改动都会让 knowledge 落在已关闭的连接上。
    """
    runtime = NativeRuntime(tmp_path / "chatty.sqlite")
    closed: list[str] = []

    def spy(name: str) -> None:
        store = getattr(runtime, name)
        original = store.close
        store.close = lambda: (closed.append(name), original())

    for store_name in ("traces", "support", "memory", "artifacts", "commerce"):
        spy(store_name)
    runtime.close()
    assert closed == ["traces", "support", "memory", "artifacts", "commerce"]
    # knowledge 复用 commerce 的连接、sessions 不持长连接：两者都没有 close 可调。
    assert not hasattr(runtime.knowledge, "close")
    assert not hasattr(runtime.sessions, "close")


def make_module(
    runtime: NativeRuntime,
    tmp_path: Path,
    script: Sequence[ToolStep | MessageStep],
) -> ChattyRunModule:
    return ChattyRunModule(
        runtime,
        model=ScriptedModel(script),
        model_id="scripted-model",
        knowledge_path=write_knowledge(tmp_path),
    )


ORDER_ARGUMENTS: dict[str, Any] = {
    "idempotency_key": "order-1",
    "product_id": "SUIT-001",
    "size": "L",
    "fulfillment_mode": "rental",
    "quantity": 1,
    "start_date": "2026-08-01",
    "end_date": "2026-08-03",
    "amount_cents": 76000,
    "address": "上海市静安区",
    "risk": "无",
}


async def test_plain_reply_maps_to_responded(runtime: NativeRuntime, tmp_path: Path) -> None:
    module = make_module(runtime, tmp_path, [MessageStep("msg_1", "你好，有什么可以帮您？")])
    response = await module.run(
        message="你好", customer_id="customer-1", request_id="request-1"
    )
    assert response.reply == "你好，有什么可以帮您？"
    assert response.customer_id == "customer-1"
    assert response.request_id == "request-1"
    assert response.session_id.startswith("session_")
    assert response.trace_id.startswith("trace_")
    assert response.status == "responded"
    assert response.business_outcome == "not_applicable"
    assert response.completion_evidence is None
    assert response.knowledge_search_results == []
    assert response.memory_events == []
    assert response.needs_human is False
    assert response.support_request_id is None


async def test_request_id_defaults_to_generated(runtime: NativeRuntime, tmp_path: Path) -> None:
    module = make_module(runtime, tmp_path, [MessageStep("msg_1", "好的。")])
    response = await module.run(message="你好", customer_id="customer-1")
    assert response.request_id.startswith("request_")


async def test_knowledge_cited_reply(runtime: NativeRuntime, tmp_path: Path) -> None:
    module = make_module(
        runtime,
        tmp_path,
        [
            ToolStep("call_1", "search_knowledge", {"query": "租期"}),
            MessageStep("msg_1", f"根据 {KNOWLEDGE_SOURCE}，租期从签收当天开始计算。"),
        ],
    )
    response = await module.run(
        message="租期从哪天开始？", customer_id="customer-1", request_id="request-1"
    )
    assert response.status == "responded"
    assert [record.id for record in response.knowledge_search_results] == [
        "policy-rental-period-1"
    ]
    assert KNOWLEDGE_SOURCE in response.reply
    assert response.needs_human is False


async def test_knowledge_reply_without_source_forces_handoff(
    runtime: NativeRuntime, tmp_path: Path
) -> None:
    module = make_module(
        runtime,
        tmp_path,
        [
            ToolStep("call_1", "search_knowledge", {"query": "租期"}),
            MessageStep("msg_1", "租期从签收当天开始计算。"),
        ],
    )
    response = await module.run(
        message="租期从哪天开始？", customer_id="customer-1", request_id="request-1"
    )
    assert response.status == "needs_human"
    assert response.needs_human is True
    assert response.business_outcome == "not_completed"
    assert response.support_request_id is not None
    assert response.completion_evidence == f"handoff:{response.support_request_id}"
    assert response.reply == "业务无法安全完成，已创建可追踪的人工支持请求。"
    receipt = runtime.support.get(response.support_request_id)
    assert receipt is not None
    assert receipt.reason == "Harness 拒绝无效操作"
    assert receipt.model_context == "Model 请求了无效或不可用的 Tool"
    assert "model_tool_call:rejected" in receipt.prior_actions
    # 收集到的知识结果在 handoff 结果中保留
    assert [r.source for r in response.knowledge_search_results] == [KNOWLEDGE_SOURCE]


async def test_blank_final_output_forces_handoff(
    runtime: NativeRuntime, tmp_path: Path
) -> None:
    module = make_module(runtime, tmp_path, [MessageStep("msg_1", "   ")])
    response = await module.run(
        message="帮我处理", customer_id="customer-1", request_id="request-1"
    )
    assert response.status == "needs_human"
    assert response.support_request_id is not None
    receipt = runtime.support.get(response.support_request_id)
    assert receipt is not None
    assert receipt.reason == "Harness 安全恢复已耗尽"
    assert receipt.model_context == "Agent 未返回可验证的客户结果"
    assert receipt.context == "帮我处理"


async def test_max_turns_forces_handoff(runtime: NativeRuntime, tmp_path: Path) -> None:
    script = [
        ToolStep(f"call_{index}", "search_knowledge", {"query": "租期"}) for index in range(12)
    ]
    module = make_module(runtime, tmp_path, script)
    response = await module.run(
        message="一直查下去", customer_id="customer-1", request_id="request-1"
    )
    assert response.status == "needs_human"
    assert response.support_request_id is not None
    receipt = runtime.support.get(response.support_request_id)
    assert receipt is not None
    assert receipt.reason == "Harness 安全恢复已耗尽"
    assert receipt.model_context == "Agent 在受限 turns 内未完成处理"
    assert "agent_loop:max_turns" in receipt.prior_actions


async def test_model_handoff_tool_produces_needs_human(
    runtime: NativeRuntime, tmp_path: Path
) -> None:
    module = make_module(
        runtime,
        tmp_path,
        [
            ToolStep(
                "call_1", "create_handoff", {"reason": "需要人工授权", "context": "客户要求退款"}
            ),
            MessageStep("msg_1", "已为您转接人工，请稍候。"),
        ],
    )
    response = await module.run(
        message="请转人工", customer_id="customer-1", request_id="request-1"
    )
    assert response.status == "needs_human"
    assert response.business_outcome == "not_completed"
    assert response.support_request_id is not None
    assert response.support_request_id.startswith("support_")
    assert response.completion_evidence == f"handoff:{response.support_request_id}"
    # 模型自己成功交接时保留其 final_output 作为 reply
    assert response.reply == "已为您转接人工，请稍候。"


async def test_verified_order_run_maps_to_completed(
    runtime: NativeRuntime, tmp_path: Path
) -> None:
    module = make_module(
        runtime,
        tmp_path,
        [
            ToolStep("call_1", "create_order", dict(ORDER_ARGUMENTS)),
            MessageStep("msg_1", "订单已创建，等待确认。"),
        ],
    )
    response = await module.run(
        message="请下单", customer_id="customer-1", request_id="request-1"
    )
    assert response.status == "completed"
    assert response.business_outcome == "verified"
    assert response.completion_evidence is not None
    assert response.completion_evidence.startswith("create_order:order_")
    assert response.completion_evidence.endswith(":pending")
    assert response.reply == "订单已创建，等待确认。"
    assert len(runtime.commerce.list_orders()) == 1


async def test_failed_order_overwrites_reply(runtime: NativeRuntime, tmp_path: Path) -> None:
    arguments = dict(ORDER_ARGUMENTS, size="XXL")
    module = make_module(
        runtime,
        tmp_path,
        [
            ToolStep("call_1", "create_order", arguments),
            MessageStep("msg_1", "已为您下单成功！"),
        ],
    )
    response = await module.run(
        message="请下单", customer_id="customer-1", request_id="request-1"
    )
    assert response.status == "not_completed"
    assert response.business_outcome == "not_completed"
    assert response.completion_evidence == "create_order:unknown_variant"
    assert response.reply == "业务操作未完成：unknown_variant"
    assert runtime.commerce.list_orders() == []


async def test_unknown_session_raises_session_not_found(
    runtime: NativeRuntime, tmp_path: Path
) -> None:
    module = make_module(runtime, tmp_path, [MessageStep("msg_1", "好的。")])
    with pytest.raises(RunFailure) as exc_info:
        await module.run(
            message="你好",
            customer_id="customer-1",
            session_id="session_missing",
            request_id="request-1",
        )
    assert exc_info.value.code == "session_not_found"
    assert exc_info.value.trace_id is None


async def test_session_customer_mismatch(runtime: NativeRuntime, tmp_path: Path) -> None:
    module = make_module(
        runtime,
        tmp_path,
        [MessageStep("msg_1", "好的。"), MessageStep("msg_2", "好的。")],
    )
    first = await module.run(message="你好", customer_id="customer-1", request_id="request-1")
    with pytest.raises(RunFailure) as exc_info:
        await module.run(
            message="你好",
            customer_id="customer-2",
            session_id=first.session_id,
            request_id="request-2",
        )
    assert exc_info.value.code == "session_customer_mismatch"


async def test_session_reuse_and_stored_messages(
    runtime: NativeRuntime, tmp_path: Path
) -> None:
    module = make_module(
        runtime,
        tmp_path,
        [MessageStep("msg_1", "收到。"), MessageStep("msg_2", "再次收到。")],
    )
    first = await module.run(message="第一句", customer_id="customer-1", request_id="request-1")
    second = await module.run(
        message="第二句",
        customer_id="customer-1",
        session_id=first.session_id,
        request_id="request-2",
    )
    assert second.session_id == first.session_id
    # run 循环写入的历史由 runtime.sessions 读出（run 模块不再提供读接口）。
    messages = await runtime.sessions.messages(
        session_id=first.session_id, customer_id="customer-1"
    )
    roles = [item.get("role") for item in messages]
    assert roles.count("user") == 2
    assert roles.count("assistant") == 2
    assert messages[0] == {"content": "第一句", "role": "user"}
    assert not hasattr(module, "session_messages")


async def test_model_exception_maps_to_llm_provider_failed(
    runtime: NativeRuntime, tmp_path: Path
) -> None:
    module = make_module(runtime, tmp_path, [])  # 脚本耗尽 → get_response 抛 RuntimeError
    with pytest.raises(RunFailure) as exc_info:
        await module.run(message="你好", customer_id="customer-1", request_id="request-1")
    failure = exc_info.value
    assert failure.code == "llm_provider_failed"
    assert failure.trace_id is not None
    assert failure.trace_id.startswith("trace_")
    assert failure.internal_error_name == "RuntimeError"


async def test_outcome_violation_becomes_run_failure(
    runtime: NativeRuntime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """出站不变量违约走 RunFailure（带 trace_id），trace 不留成"成功"。"""
    module = make_module(runtime, tmp_path, [MessageStep("msg_1", "好的。")])

    def broken_result(context: Any, **_: Any) -> AgentRunResult:
        # verified 却没有 completion_evidence：status 会被派生成 completed，
        # contracts 的复算立刻拒绝。
        return AgentRunResult(
            reply="好的。",
            knowledge_search_results=[],
            memory_events=[],
            business_outcome="verified",
            completion_evidence=None,
            support_request_id=None,
        )

    monkeypatch.setattr("chatty.run.complete_agent_run", broken_result)
    with pytest.raises(RunFailure) as exc_info:
        await module.run(message="你好", customer_id="customer-1", request_id="request-1")
    failure = exc_info.value
    assert failure.code == "run_contract_violated"
    assert failure.trace_id is not None
    summary = runtime.traces.get(failure.trace_id)
    assert summary is not None
    assert summary.status == "failed"
    errors = [span.error for span in runtime.traces.spans(failure.trace_id)]
    assert "run_contract_violated" in errors


def test_llm_not_configured_raised_at_construction(
    runtime: NativeRuntime, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(RunFailure) as exc_info:
        ChattyRunModule(runtime, knowledge_path=write_knowledge(tmp_path))
    assert exc_info.value.code == "llm_not_configured"


async def test_model_from_env_priority(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("MODEL_ID", "env-model")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://env.example.com")
    model, model_id, client = model_from_env()
    assert model_id == "env-model"
    assert "env.example.com" in str(client.base_url)
    await client.close()
    model, model_id, client = model_from_env(
        model_id="arg-model", base_url="https://arg.example.com"
    )
    assert model_id == "arg-model"
    assert "arg.example.com" in str(client.base_url)
    await client.close()
    monkeypatch.delenv("MODEL_ID")
    monkeypatch.delenv("OPENAI_BASE_URL")
    model, model_id, client = model_from_env()
    assert model_id == DEFAULT_MODEL_ID == "deepseek-v4-pro"
    assert str(client.base_url).startswith(DEFAULT_BASE_URL)
    await client.close()


def test_agent_construction_and_instructions() -> None:
    lines = AGENT_INSTRUCTIONS.splitlines()
    assert len(lines) == 19
    assert AGENT_INSTRUCTIONS.count("\n") == 19  # 末行（含最后一行）都以换行结尾
    assert lines[0] == "你是 Chatty，一个简洁、可靠、可追溯的研究与内容生产 Agent。"
    assert lines[-2] == "需要人工判断、授权或无法安全完成时，必须调用 create_handoff；"
    assert lines[-1] == "不能只回复“请联系客服”，只有持久化 receipt 才算已交接。"
    agent = build_agent(model=ScriptedModel([]), tools=[])
    assert agent.name == "Chatty"
    assert agent.instructions == AGENT_INSTRUCTIONS
    assert agent.model_settings.extra_body == {"thinking": {"type": "disabled"}}
