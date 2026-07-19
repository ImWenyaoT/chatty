from __future__ import annotations

from typing import Any

from agents.tracing import Span, Trace, TracingProcessor

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
