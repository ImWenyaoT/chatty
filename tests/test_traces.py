"""TraceStore 契约测试。

覆盖：trace 生命周期与投影、span 记录、addMissingColumns 迁移、来源 JSON 往返。
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from chatty.traces import TraceStore


@pytest.fixture
def traces(tmp_path: Path) -> TraceStore:
    return TraceStore(tmp_path / "chatty.sqlite")


class TestTraceStore:
    def test_start_and_get(self, traces: TraceStore) -> None:
        traces.start("trace-1", "session-1", "deepseek-chat")
        trace = traces.get("trace-1")
        assert trace is not None
        assert trace.status == "running"
        assert trace.summary == "Agent run started"
        assert trace.model_id == "deepseek-chat"
        assert trace.duration_ms >= 0
        assert trace.knowledge_sources == []
        assert trace.memory_sources == []
        assert trace.business_outcome is None
        assert traces.get("trace-missing") is None

    def test_complete_and_fail(self, traces: TraceStore) -> None:
        traces.start("trace-1", "s", "m")
        traces.complete("trace-1")
        completed = traces.get("trace-1")
        assert completed is not None
        assert (completed.status, completed.summary) == ("completed", "Agent run completed")
        traces.start("trace-2", "s", "m")
        traces.fail("trace-2")
        failed = traces.get("trace-2")
        assert failed is not None
        assert (failed.status, failed.summary) == ("failed", "Agent run failed")

    def test_record_outcome_dedupes_and_sorts_sources(self, traces: TraceStore) -> None:
        traces.start("trace-1", "s", "m")
        traces.record_outcome(
            "trace-1",
            business_outcome="verified",
            completion_evidence="order confirmed",
            knowledge_sources=["b", "a", "b"],
            memory_sources=[],
            support_request_id=None,
        )
        trace = traces.get("trace-1")
        assert trace is not None
        assert trace.business_outcome == "verified"
        assert trace.knowledge_sources == ["a", "b"]
        raw = traces.database.execute(
            "SELECT knowledge_sources FROM local_traces WHERE trace_id = 'trace-1'"
        ).fetchone()
        assert raw[0] == '["a","b"]'  # 去重 + 排序 + 紧凑分隔符

    def test_list_recent_order_and_limit(self, traces: TraceStore) -> None:
        for trace_id in ("trace-a", "trace-b", "trace-c"):
            traces.start(trace_id, "s", "m")
        traces.database.execute(
            "UPDATE local_traces SET created_at = '2026-07-0' || "
            "(CASE trace_id WHEN 'trace-a' THEN '1' WHEN 'trace-b' THEN '2' ELSE '2' END) "
            "|| 'T00:00:00.000Z'"
        )
        listed = traces.list_recent(limit=2)
        # created_at DESC；b 与 c 并列同刻 → trace_id DESC
        assert [trace.trace_id for trace in listed] == ["trace-c", "trace-b"]

    def test_record_span_replaces_by_id(self, traces: TraceStore) -> None:
        traces.record_span(
            span_id="span-1",
            trace_id="trace-1",
            parent_id=None,
            span_type="generation",
            failed=False,
            started_at="2026-07-01T00:00:00.000Z",
            ended_at="2026-07-01T00:00:01.500Z",
        )
        traces.record_span(
            span_id="span-1",
            trace_id="trace-1",
            parent_id=None,
            span_type="generation",
            failed=True,
            name="draft",
            started_at="2026-07-01T00:00:00.000Z",
            ended_at="2026-07-01T00:00:01.500Z",
        )
        spans = traces.spans("trace-1")
        assert len(spans) == 1
        span = spans[0]
        assert span.status == "failed"
        assert span.summary == "generation draft failed"
        assert span.error == "sdk_span_error"
        assert span.duration_ms == 1500

    def test_span_summary_without_name(self, traces: TraceStore) -> None:
        traces.record_span(
            span_id="span-1", trace_id="t", parent_id=None, span_type="handoff", failed=False
        )
        span = traces.spans("t")[0]
        assert span.summary == "handoff span completed"
        assert span.error is None
        assert span.duration_ms is None  # started/ended 缺失 → NULL

    def test_record_tool_event(self, traces: TraceStore) -> None:
        with pytest.raises(ValueError, match="invalid tool event status"):
            traces.record_tool_event("t", status="running", summary="x")
        traces.record_tool_event("t", status="completed", summary="check_availability ok")
        span = traces.spans("t")[0]
        assert span.span_id.startswith("span_")
        assert (span.span_type, span.status) == ("tool", "completed")
        assert span.parent_id is None

    def test_record_error_span(self, traces: TraceStore) -> None:
        traces.record_error("t", code="llm_provider_failed")
        span = traces.spans("t")[0]
        assert (span.span_type, span.status) == ("error", "failed")
        assert span.summary == "llm_provider_failed"
        assert span.error == "llm_provider_failed"
        assert span.started_at is not None and span.ended_at is not None
        assert span.duration_ms == 0

    def test_span_types_distinct_sorted(self, traces: TraceStore) -> None:
        traces.record_tool_event("t", status="completed", summary="a")
        traces.record_tool_event("t", status="failed", summary="b")
        traces.record_error("t", code="x")
        assert traces.span_types("t") == ["error", "tool"]
        assert traces.span_types("other") == []


LEGACY_TRACES_DDL = """
CREATE TABLE local_traces (
    trace_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    model_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)
"""

LEGACY_SPANS_DDL = """
CREATE TABLE local_spans (
    span_id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    parent_id TEXT,
    span_type TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)
"""


class TestAddMissingColumnsMigration:
    def test_legacy_database_upgraded_in_place(self, tmp_path: Path) -> None:
        database = tmp_path / "legacy.sqlite"
        connection = sqlite3.connect(database)
        connection.execute(LEGACY_TRACES_DDL)
        connection.execute(LEGACY_SPANS_DDL)
        connection.execute(
            "INSERT INTO local_traces (trace_id, session_id, status, summary, model_id) "
            "VALUES ('trace-legacy', 's', 'completed', 'done', 'm')"
        )
        connection.execute(
            "INSERT INTO local_spans (span_id, trace_id, parent_id, span_type, status, summary) "
            "VALUES ('span-legacy', 'trace-legacy', NULL, 'tool', 'completed', 'ok')"
        )
        connection.commit()
        connection.close()

        store = TraceStore(database)
        trace_columns = {
            row[1] for row in store.database.execute("PRAGMA table_info(local_traces)")
        }
        assert {
            "business_outcome",
            "completion_evidence",
            "knowledge_sources",
            "memory_sources",
            "support_request_id",
        } <= trace_columns
        span_columns = {
            row[1] for row in store.database.execute("PRAGMA table_info(local_spans)")
        }
        assert {"started_at", "ended_at", "error"} <= span_columns

        trace = store.get("trace-legacy")
        assert trace is not None
        assert trace.knowledge_sources == []  # ADD COLUMN DEFAULT '[]' 回填旧行
        assert trace.memory_sources == []
        assert trace.business_outcome is None
        assert trace.support_request_id is None
        span = store.spans("trace-legacy")[0]
        assert span.started_at is None
        assert span.duration_ms is None
        assert span.error is None
        store.close()

    def test_migration_is_idempotent(self, tmp_path: Path) -> None:
        database = tmp_path / "chatty.sqlite"
        TraceStore(database).close()
        store = TraceStore(database)  # 第二次构造不应因列已存在而失败
        store.start("t", "s", "m")
        assert store.get("t") is not None
        store.close()


class TestSourcesJsonRoundTrip:
    def test_unicode_sources_survive(self, traces: TraceStore) -> None:
        traces.start("t", "s", "m")
        traces.record_outcome(
            "t",
            business_outcome="verified",
            completion_evidence=None,
            knowledge_sources=["知识#1"],
            memory_sources=["记忆#2"],
            support_request_id="support_1",
        )
        trace = traces.get("t")
        assert trace is not None
        assert trace.knowledge_sources == ["知识#1"]
        assert trace.memory_sources == ["记忆#2"]
        assert trace.support_request_id == "support_1"
        raw = traces.database.execute(
            "SELECT knowledge_sources FROM local_traces WHERE trace_id = 't'"
        ).fetchone()
        assert json.loads(raw[0]) == ["知识#1"]
        assert "\\u" not in raw[0]  # ensure_ascii=False
