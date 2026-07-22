"""MemoryStore / SupportRequestStore / TraceStore 契约测试。

覆盖：会话绑定错误、记忆打分回退、支持请求幂等冲突、trace 投影与 addMissingColumns 迁移。
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from chatty.store import (
    MemoryStore,
    SessionCustomerMismatchError,
    SessionNotFoundError,
    SupportRequestIdempotencyConflictError,
    SupportRequestStore,
    TraceStore,
)


@pytest.fixture
def memory(tmp_path: Path) -> MemoryStore:
    return MemoryStore(tmp_path / "chatty.sqlite")


@pytest.fixture
def support(tmp_path: Path) -> SupportRequestStore:
    return SupportRequestStore(tmp_path / "chatty.sqlite")


@pytest.fixture
def traces(tmp_path: Path) -> TraceStore:
    return TraceStore(tmp_path / "chatty.sqlite")


class TestSessionBinding:
    def test_bind_then_rebind_same_customer(self, memory: MemoryStore) -> None:
        memory.bind_session(session_id="session-1", customer_id="customer-1")
        memory.bind_session(session_id="session-1", customer_id="customer-1")
        memory.require_session(session_id="session-1", customer_id="customer-1")

    def test_bind_other_customer_mismatch(self, memory: MemoryStore) -> None:
        memory.bind_session(session_id="session-1", customer_id="customer-1")
        with pytest.raises(
            SessionCustomerMismatchError, match="session belongs to another customer"
        ):
            memory.bind_session(session_id="session-1", customer_id="customer-2")

    def test_require_unknown_session_not_found(self, memory: MemoryStore) -> None:
        with pytest.raises(
            SessionNotFoundError, match="session was not issued by this Harness"
        ):
            memory.require_session(session_id="session-x", customer_id="customer-1")

    def test_require_mismatch(self, memory: MemoryStore) -> None:
        memory.bind_session(session_id="session-1", customer_id="customer-1")
        with pytest.raises(SessionCustomerMismatchError):
            memory.require_session(session_id="session-1", customer_id="customer-2")


def set_created_at(store: MemoryStore, memory_id: str, created_at: str) -> None:
    store.database.execute(
        "UPDATE customer_memories SET created_at = ? WHERE memory_id = ?",
        (created_at, memory_id),
    )


class TestMemorySaveAndSearch:
    def test_save_returns_row(self, memory: MemoryStore) -> None:
        saved = memory.save(customer_id="customer-1", fact="喜欢深蓝色", source_id="run-1")
        assert saved.memory_id.startswith("memory_")
        assert saved.customer_id == "customer-1"
        assert saved.fact == "喜欢深蓝色"
        assert saved.source_id == "run-1"
        assert saved.created_at.endswith("Z")  # strftime 毫秒精度 Z 结尾

    def test_like_search_scoped_to_customer(self, memory: MemoryStore) -> None:
        memory.save(customer_id="customer-1", fact="偏好深蓝色西装", source_id="r1")
        memory.save(customer_id="customer-2", fact="偏好深蓝色西装", source_id="r2")
        results = memory.search(customer_id="customer-1", query="深蓝色", limit=10)
        assert [item.customer_id for item in results] == ["customer-1"]

    def test_like_search_orders_by_created_desc(self, memory: MemoryStore) -> None:
        old = memory.save(customer_id="c", fact="西装 A", source_id="r")
        new = memory.save(customer_id="c", fact="西装 B", source_id="r")
        set_created_at(memory, old.memory_id, "2026-07-01T00:00:00.000Z")
        set_created_at(memory, new.memory_id, "2026-07-02T00:00:00.000Z")
        results = memory.search(customer_id="c", query="西装", limit=10)
        assert [item.fact for item in results] == ["西装 B", "西装 A"]

    def test_like_escapes_wildcards(self, memory: MemoryStore) -> None:
        memory.save(customer_id="c", fact="满意度 100%", source_id="r")
        memory.save(customer_id="c", fact="满意度 100x", source_id="r")
        results = memory.search(customer_id="c", query="100%", limit=10)
        assert [item.fact for item in results] == ["满意度 100%"]
        memory.save(customer_id="c", fact="型号 a_b", source_id="r")
        memory.save(customer_id="c", fact="型号 axb", source_id="r")
        results = memory.search(customer_id="c", query="a_b", limit=10)
        assert [item.fact for item in results] == ["型号 a_b"]

    def test_like_is_ascii_case_insensitive(self, memory: MemoryStore) -> None:
        memory.save(customer_id="c", fact="购买过 SUIT-001", source_id="r")
        results = memory.search(customer_id="c", query="suit", limit=10)
        assert len(results) == 1

    def test_character_fallback_scoring(self, memory: MemoryStore) -> None:
        strong = memory.save(customer_id="c", fact="蓝色的西装最合身", source_id="r")
        weak = memory.save(customer_id="c", fact="蓝天白云", source_id="r")
        memory.save(customer_id="c", fact="毫无关联", source_id="r")
        # 无子串命中 → 单字回退：strong 命中 蓝/色/西/装 4 字，weak 只命中 蓝
        results = memory.search(customer_id="c", query="蓝色西装", limit=10)
        assert [item.memory_id for item in results[:2]] == [strong.memory_id, weak.memory_id]
        assert len(results) == 2  # 零命中行也会被候选查询排除

    def test_fallback_exact_term_score_beats_characters(self, memory: MemoryStore) -> None:
        term_hit = memory.save(customer_id="c", fact="记录：西装 与 蓝色 都提过", source_id="r")
        char_hit = memory.save(customer_id="c", fact="蓝色西天装货", source_id="r")
        set_created_at(memory, term_hit.memory_id, "2026-07-01T00:00:00.000Z")
        set_created_at(memory, char_hit.memory_id, "2026-07-02T00:00:00.000Z")
        # query 切词为 [西装, 蓝色]；term_hit 两词子串命中（2*3+2*3=12 + 4 字）胜过
        # char_hit（无词命中，仅 4 字 + 更新的 created_at）
        results = memory.search(customer_id="c", query="西装,蓝色", limit=10)
        assert results[0].memory_id == term_hit.memory_id

    def test_fallback_respects_limit(self, memory: MemoryStore) -> None:
        best = memory.save(customer_id="c", fact="蓝色的西装", source_id="r")
        memory.save(customer_id="c", fact="蓝天", source_id="r")
        results = memory.search(customer_id="c", query="蓝色西装", limit=1)
        assert [item.memory_id for item in results] == [best.memory_id]

    def test_stop_characters_disable_fallback(self, memory: MemoryStore) -> None:
        memory.save(customer_id="c", fact="客户信息若干", source_id="r")
        # 查询全部落在停用字集 → 候选字符为空 → 不回退
        assert memory.search(customer_id="c", query="的了和客户信息", limit=10) == []

    def test_blank_query_never_falls_back(self, memory: MemoryStore) -> None:
        memory.save(customer_id="c", fact="西装", source_id="r")
        assert memory.search(customer_id="c", query="   ", limit=10) == []


class TestSupportRequests:
    def create(self, store: SupportRequestStore, **overrides: object) -> object:
        payload: dict[str, object] = {
            "customer_id": "customer-1",
            "session_id": "session-1",
            "reason": "客户要求人工",
            "context": "多次沟通未解决",
            "model_context": "模型上下文",
            "prior_actions": ["查询订单", "检查库存"],
            "idempotency_key": "handoff-1",
        }
        payload.update(overrides)
        return store.create(**payload)  # type: ignore[arg-type]

    def test_create_and_strip(self, support: SupportRequestStore) -> None:
        request = self.create(
            support,
            reason="  客户要求人工  ",
            context=" 多次沟通未解决 ",
            model_context=" 模型上下文 ",
        )
        assert request.id.startswith("support_")
        assert request.status == "open"
        assert request.reason == "客户要求人工"
        assert request.context == "多次沟通未解决"
        assert request.model_context == "模型上下文"
        assert request.prior_actions == ["查询订单", "检查库存"]

    def test_prior_actions_stored_as_compact_json(self, support: SupportRequestStore) -> None:
        request = self.create(support)
        row = support.database.execute(
            "SELECT prior_actions FROM support_requests WHERE id = ?", (request.id,)
        ).fetchone()
        assert row[0] == '["查询订单","检查库存"]'

    def test_empty_reason_or_context_rejected(self, support: SupportRequestStore) -> None:
        for overrides in ({"reason": "   "}, {"context": ""}):
            with pytest.raises(ValueError, match="support reason and context are required"):
                self.create(support, **overrides)

    def test_idempotent_replay_returns_original(self, support: SupportRequestStore) -> None:
        first = self.create(support)
        replay = self.create(support, reason="客户要求人工 ")  # trim 后证据一致
        assert replay == first

    def test_conflict_on_different_evidence(self, support: SupportRequestStore) -> None:
        self.create(support)
        with pytest.raises(
            SupportRequestIdempotencyConflictError,
            match="handoff idempotency key was reused with different evidence",
        ):
            self.create(support, context="完全不同的上下文")

    def test_conflict_on_different_prior_actions(self, support: SupportRequestStore) -> None:
        self.create(support)
        with pytest.raises(SupportRequestIdempotencyConflictError):
            self.create(support, prior_actions=["查询订单"])

    def test_get_and_list(self, support: SupportRequestStore) -> None:
        first = self.create(support, idempotency_key="handoff-1")
        second = self.create(support, idempotency_key="handoff-2")
        assert support.get(first.id) == first
        assert support.get("support_missing") is None
        support.database.execute(
            "UPDATE support_requests SET created_at = '2026-07-01 00:00:00' WHERE id = ?",
            (first.id,),
        )
        support.database.execute(
            "UPDATE support_requests SET created_at = '2026-07-02 00:00:00' WHERE id = ?",
            (second.id,),
        )
        listed = support.list_all()
        assert [request.id for request in listed] == [second.id, first.id]

    def test_list_ties_break_by_id_desc(self, support: SupportRequestStore) -> None:
        first = self.create(support, idempotency_key="handoff-1")
        second = self.create(support, idempotency_key="handoff-2")
        support.database.execute(
            "UPDATE support_requests SET created_at = '2026-07-01 00:00:00'"
        )
        expected = sorted([first.id, second.id], reverse=True)
        assert [request.id for request in support.list_all()] == expected


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
