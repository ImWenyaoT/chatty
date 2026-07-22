"""tracing 路由与本地 trace 行写入测试（specs/runtime-eval.md §6）。

上半部分用 stub Trace/Span 单测 RuntimeTracingRouter 的路由、缺省值与脱敏；
下半部分经 ChattyRunModule 集成验证一次 run 的 trace/span 生命周期时序（§6.6）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from test_run import MessageStep, ScriptedModel, ToolStep, make_module, write_knowledge

from chatty.harness import RunFailure
from chatty.run import ChattyRunModule
from chatty.runtime import NativeRuntime
from chatty.traces import TraceStore
from chatty.tracing import RuntimeTracingRouter, install_runtime_tracing


@dataclass
class StubTrace:
    trace_id: str
    exported: dict[str, Any] | None = None

    def export(self) -> dict[str, Any] | None:
        return self.exported


@dataclass
class StubSpanData:
    type: str
    name: str | None = None


@dataclass
class StubSpan:
    span_id: str
    trace_id: str
    span_data: StubSpanData
    parent_id: str | None = None
    error: dict[str, Any] | None = None
    started_at: str | None = None
    ended_at: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@pytest.fixture
def trace_store(tmp_path: Path) -> TraceStore:
    store = TraceStore(tmp_path / "traces.sqlite")
    yield store
    store.close()


@pytest.fixture
def runtime(tmp_path: Path) -> NativeRuntime:
    native_runtime = NativeRuntime(tmp_path / "chatty.sqlite")
    yield native_runtime
    native_runtime.close()


def test_router_routes_registered_trace(trace_store: TraceStore) -> None:
    router = RuntimeTracingRouter()
    router.register("trace_a", trace_store)
    router.on_trace_start(
        StubTrace("trace_a", {"group_id": "session_a", "metadata": {"model_id": "model-a"}})
    )
    summary = trace_store.get("trace_a")
    assert summary is not None
    assert summary.status == "running"
    assert summary.summary == "Agent run started"
    assert summary.session_id == "session_a"
    assert summary.model_id == "model-a"
    router.on_span_end(
        StubSpan(
            span_id="span_1",
            trace_id="trace_a",
            span_data=StubSpanData(type="agent", name="Chatty"),
            started_at="2026-07-22T00:00:00.000Z",
            ended_at="2026-07-22T00:00:01.500Z",
        )
    )
    router.on_span_end(
        StubSpan(
            span_id="span_2",
            trace_id="trace_a",
            span_data=StubSpanData(type="generation"),
            parent_id="span_1",
        )
    )
    spans = trace_store.spans("trace_a")
    assert [span.span_id for span in spans] == ["span_1", "span_2"]
    assert spans[0].summary == "agent Chatty completed"
    assert spans[0].status == "completed"
    assert spans[0].duration_ms == 1500
    assert spans[1].summary == "generation span completed"
    assert spans[1].parent_id == "span_1"
    assert spans[1].duration_ms is None
    assert trace_store.span_types("trace_a") == ["agent", "generation"]
    router.on_trace_end(StubTrace("trace_a", {}))
    summary = trace_store.get("trace_a")
    assert summary is not None
    assert summary.status == "completed"
    assert summary.summary == "Agent run completed"
    # on_trace_end 自动 discard：后续 span 一律忽略
    router.on_span_end(
        StubSpan(span_id="span_3", trace_id="trace_a", span_data=StubSpanData(type="function"))
    )
    assert len(trace_store.spans("trace_a")) == 2


def test_router_ignores_unregistered_trace(trace_store: TraceStore) -> None:
    router = RuntimeTracingRouter()
    router.on_trace_start(StubTrace("trace_unknown", {"group_id": "s"}))
    router.on_span_end(
        StubSpan(span_id="span_1", trace_id="trace_unknown", span_data=StubSpanData(type="agent"))
    )
    router.on_trace_end(StubTrace("trace_unknown", {}))
    assert trace_store.list_recent() == []


def test_router_defaults_and_discard(trace_store: TraceStore) -> None:
    router = RuntimeTracingRouter()
    router.register("trace_b", trace_store)
    # export() 为 None 或缺 group_id/metadata → unknown-session / unknown-model
    router.on_trace_start(StubTrace("trace_b", None))
    summary = trace_store.get("trace_b")
    assert summary is not None
    assert summary.session_id == "unknown-session"
    assert summary.model_id == "unknown-model"
    router.discard("trace_b")
    router.on_span_end(
        StubSpan(span_id="span_1", trace_id="trace_b", span_data=StubSpanData(type="agent"))
    )
    assert trace_store.spans("trace_b") == []
    router.discard("trace_b")  # 幂等


def test_failed_span_error_is_redacted(trace_store: TraceStore) -> None:
    router = RuntimeTracingRouter()
    router.register("trace_c", trace_store)
    router.on_span_end(
        StubSpan(
            span_id="span_1",
            trace_id="trace_c",
            span_data=StubSpanData(type="function", name="create_order"),
            error={"message": "含敏感参数的异常文本", "data": {"api_key": "sk-secret"}},
        )
    )
    [span] = trace_store.spans("trace_c")
    assert span.status == "failed"
    assert span.summary == "function create_order failed"
    # 失败原因收敛为固定字符串，不透传异常文本（§6.3 脱敏）
    assert span.error == "sdk_span_error"


def test_install_runtime_tracing_returns_singleton() -> None:
    first = install_runtime_tracing()
    second = install_runtime_tracing()
    assert first is second
    assert isinstance(first, RuntimeTracingRouter)


async def test_run_writes_trace_rows(runtime: NativeRuntime, tmp_path: Path) -> None:
    module = make_module(
        runtime,
        tmp_path,
        [
            ToolStep("call_1", "search_knowledge", {"query": "租期"}),
            MessageStep("msg_1", "根据 seller-policy://rental-period，租期从签收当天开始计算。"),
        ],
    )
    response = await module.run(
        message="租期从哪天开始？", customer_id="customer-1", request_id="request-1"
    )
    summary = runtime.traces.get(response.trace_id)
    assert summary is not None
    assert summary.status == "completed"
    assert summary.summary == "Agent run completed"
    assert summary.session_id == response.session_id
    assert summary.model_id == "scripted-model"
    assert summary.business_outcome == "not_applicable"
    assert summary.completion_evidence is None
    assert summary.knowledge_sources == ["seller-policy://rental-period"]
    assert summary.memory_sources == []
    assert summary.support_request_id is None
    assert summary.duration_ms >= 0
    span_types = runtime.traces.span_types(response.trace_id)
    assert "agent" in span_types
    assert "function" in span_types
    for span in runtime.traces.spans(response.trace_id):
        assert "租期" not in span.summary  # 脱敏：span 不含消息内容/工具参数


async def test_forced_handoff_writes_tool_span_and_outcome(
    runtime: NativeRuntime, tmp_path: Path
) -> None:
    module = make_module(runtime, tmp_path, [MessageStep("msg_1", "   ")])
    response = await module.run(
        message="帮我处理", customer_id="customer-1", request_id="request-1"
    )
    assert response.status == "needs_human"
    summary = runtime.traces.get(response.trace_id)
    assert summary is not None
    assert summary.status == "completed"
    assert summary.business_outcome == "not_completed"
    assert summary.completion_evidence == f"handoff:{response.support_request_id}"
    assert summary.support_request_id == response.support_request_id
    tool_spans = [
        span for span in runtime.traces.spans(response.trace_id) if span.span_type == "tool"
    ]
    assert [span.summary for span in tool_spans] == ["Harness-enforced handoff receipt created"]
    assert tool_spans[0].status == "completed"


async def test_failed_run_writes_error_span(runtime: NativeRuntime, tmp_path: Path) -> None:
    module = make_module(runtime, tmp_path, [])  # 脚本耗尽 → RuntimeError
    with pytest.raises(RunFailure) as exc_info:
        await module.run(message="你好", customer_id="customer-1", request_id="request-1")
    trace_id = exc_info.value.trace_id
    assert trace_id is not None
    summary = runtime.traces.get(trace_id)
    assert summary is not None
    assert summary.status == "failed"
    assert summary.summary == "Agent run failed"
    error_spans = [
        span for span in runtime.traces.spans(trace_id) if span.span_type == "error"
    ]
    assert len(error_spans) == 1
    assert error_spans[0].status == "failed"
    assert error_spans[0].summary == "llm_provider_failed"
    assert error_spans[0].error == "llm_provider_failed"
    assert "error" in runtime.traces.span_types(trace_id)


async def test_two_modules_route_by_trace_id(tmp_path: Path) -> None:
    """两个 runtime 并存时，span/trace 各写各库（§6.2 路由的存在意义）。"""
    runtime_a = NativeRuntime(tmp_path / "a.sqlite")
    runtime_b = NativeRuntime(tmp_path / "b.sqlite")
    try:
        knowledge = write_knowledge(tmp_path)
        module_a = ChattyRunModule(
            runtime_a,
            model=ScriptedModel([MessageStep("msg_1", "A 的回复。")]),
            model_id="model-a",
            knowledge_path=knowledge,
        )
        module_b = ChattyRunModule(
            runtime_b,
            model=ScriptedModel([MessageStep("msg_1", "B 的回复。")]),
            model_id="model-b",
            knowledge_path=knowledge,
        )
        response_a = await module_a.run(
            message="你好", customer_id="customer-a", request_id="request-a"
        )
        response_b = await module_b.run(
            message="你好", customer_id="customer-b", request_id="request-b"
        )
        assert runtime_a.traces.get(response_a.trace_id) is not None
        assert runtime_a.traces.get(response_b.trace_id) is None
        assert runtime_b.traces.get(response_b.trace_id) is not None
        assert runtime_b.traces.get(response_a.trace_id) is None
        summary_b = runtime_b.traces.get(response_b.trace_id)
        assert summary_b is not None
        assert summary_b.model_id == "model-b"
    finally:
        runtime_a.close()
        runtime_b.close()
