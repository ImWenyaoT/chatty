from __future__ import annotations

from threading import Lock
from typing import Any

from agents.tracing import Span, Trace, TracingProcessor, set_trace_processors

from chatty.store import TraceStore


class SQLiteTracingProcessor(TracingProcessor):
    """Persists safe SDK trace metadata without Model or Tool payloads."""

    def __init__(self, store: TraceStore) -> None:
        self.store = store

    def on_trace_start(self, trace: Trace) -> None:
        exported = trace.export() or {}
        metadata = exported.get("metadata")
        model_id = metadata.get("model_id") if isinstance(metadata, dict) else None
        group_id = exported.get("group_id")
        self.store.start(
            trace.trace_id,
            group_id if isinstance(group_id, str) else "unknown-session",
            model_id if isinstance(model_id, str) else "unknown-model",
        )

    def on_trace_end(self, trace: Trace) -> None:
        self.store.complete(trace.trace_id)

    def on_span_start(self, span: Span[Any]) -> None:
        return None

    def on_span_end(self, span: Span[Any]) -> None:
        span_name = getattr(span.span_data, "name", None)
        self.store.record_span(
            span_id=span.span_id,
            trace_id=span.trace_id,
            parent_id=span.parent_id,
            span_type=span.span_data.type,
            failed=span.error is not None,
            name=span_name if isinstance(span_name, str) else None,
            started_at=span.started_at,
            ended_at=span.ended_at,
        )

    def shutdown(self) -> None:
        return None

    def force_flush(self) -> None:
        return None


class RuntimeTracingRouter(TracingProcessor):
    """Routes each SDK trace to the runtime that registered its trace ID."""

    def __init__(self) -> None:
        self._processors: dict[str, SQLiteTracingProcessor] = {}
        self._lock = Lock()

    def register(self, trace_id: str, processor: SQLiteTracingProcessor) -> None:
        with self._lock:
            self._processors[trace_id] = processor

    def discard(self, trace_id: str) -> None:
        with self._lock:
            self._processors.pop(trace_id, None)

    def on_trace_start(self, trace: Trace) -> None:
        if processor := self._processor(trace.trace_id):
            processor.on_trace_start(trace)

    def on_trace_end(self, trace: Trace) -> None:
        if processor := self._processor(trace.trace_id):
            processor.on_trace_end(trace)
        self.discard(trace.trace_id)

    def on_span_start(self, span: Span[Any]) -> None:
        if processor := self._processor(span.trace_id):
            processor.on_span_start(span)

    def on_span_end(self, span: Span[Any]) -> None:
        if processor := self._processor(span.trace_id):
            processor.on_span_end(span)

    def shutdown(self) -> None:
        with self._lock:
            processors = set(self._processors.values())
            self._processors.clear()
        for processor in processors:
            processor.shutdown()

    def force_flush(self) -> None:
        with self._lock:
            processors = set(self._processors.values())
        for processor in processors:
            processor.force_flush()

    def _processor(self, trace_id: str) -> SQLiteTracingProcessor | None:
        with self._lock:
            return self._processors.get(trace_id)


_RUNTIME_TRACING_ROUTER = RuntimeTracingRouter()
_RUNTIME_TRACING_INSTALLED = False
_RUNTIME_TRACING_INSTALL_LOCK = Lock()


def install_runtime_tracing() -> RuntimeTracingRouter:
    global _RUNTIME_TRACING_INSTALLED
    with _RUNTIME_TRACING_INSTALL_LOCK:
        if not _RUNTIME_TRACING_INSTALLED:
            set_trace_processors([_RUNTIME_TRACING_ROUTER])
            _RUNTIME_TRACING_INSTALLED = True
    return _RUNTIME_TRACING_ROUTER
