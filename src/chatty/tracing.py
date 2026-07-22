"""SDK tracing → 本地 SQLite 路由（specs/runtime-eval.md §6）。

进程级单例 RuntimeTracingRouter 经 set_trace_processors 一次性替换 SDK 默认的
OpenAI 后端 exporter：任何 trace 数据都不出进程。按 trace_id 路由到对应 runtime
的 TraceStore（多 runtime / 多测试并存的关键）；未注册的 trace/span 一律忽略。

脱敏（§6.3）：trace_include_sensitive_data=False 使 SDK span 不含 prompt/补全/
工具参数；本地 store 也只落 id、类型、时间戳、名称与固定 summary，span 失败原因
统一收敛为 sdk_span_error——永不写入消息内容、工具入参出参或 API key。
"""

from __future__ import annotations

import threading
from typing import Any

from agents.tracing import Span, Trace, TracingProcessor, set_trace_processors

from chatty.traces import TraceStore


class RuntimeTracingRouter(TracingProcessor):
    """按 trace_id 把 SDK 回调路由到已注册的 TraceStore（§6.2）。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stores: dict[str, TraceStore] = {}

    def register(self, trace_id: str, trace_store: TraceStore) -> None:
        with self._lock:
            self._stores[trace_id] = trace_store

    def discard(self, trace_id: str) -> None:
        with self._lock:
            self._stores.pop(trace_id, None)

    def on_trace_start(self, trace: Trace) -> None:
        store = self._store_for(trace.trace_id)
        if store is None:
            return
        # Trace 对象没有 group_id/metadata 直接属性，经 export() 读（旧实现验证过）。
        exported = trace.export() or {}
        group_id = exported.get("group_id")
        metadata = exported.get("metadata")
        model_id = metadata.get("model_id") if isinstance(metadata, dict) else None
        store.start(
            trace.trace_id,
            group_id if isinstance(group_id, str) else "unknown-session",
            model_id if isinstance(model_id, str) else "unknown-model",
        )

    def on_trace_end(self, trace: Trace) -> None:
        store = self._store_for(trace.trace_id)
        if store is not None:
            store.complete(trace.trace_id)
        # run 侧 finally 也会 discard；这里先注销，二者幂等。
        self.discard(trace.trace_id)

    def on_span_start(self, span: Span[Any]) -> None:
        return

    def on_span_end(self, span: Span[Any]) -> None:
        store = self._store_for(span.trace_id)
        if store is None:
            return
        name = getattr(span.span_data, "name", None)
        store.record_span(
            span_id=span.span_id,
            trace_id=span.trace_id,
            parent_id=span.parent_id,
            span_type=span.span_data.type,
            failed=span.error is not None,
            name=name if isinstance(name, str) else None,
            started_at=span.started_at,
            ended_at=span.ended_at,
        )

    def shutdown(self) -> None:
        return

    def force_flush(self) -> None:
        return

    def _store_for(self, trace_id: str) -> TraceStore | None:
        with self._lock:
            return self._stores.get(trace_id)


_RUNTIME_TRACING_ROUTER = RuntimeTracingRouter()
_RUNTIME_TRACING_INSTALLED = False
_RUNTIME_TRACING_INSTALL_LOCK = threading.Lock()


def install_runtime_tracing() -> RuntimeTracingRouter:
    """把进程级路由器装入 SDK（只装一次，线程安全），返回单例路由器。"""
    global _RUNTIME_TRACING_INSTALLED
    with _RUNTIME_TRACING_INSTALL_LOCK:
        if not _RUNTIME_TRACING_INSTALLED:
            set_trace_processors([_RUNTIME_TRACING_ROUTER])
            _RUNTIME_TRACING_INSTALLED = True
    return _RUNTIME_TRACING_ROUTER
