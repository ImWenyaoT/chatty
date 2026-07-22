"""MemoryStore 契约测试。

覆盖：会话绑定错误、记忆保存与子串搜索、单字回退打分。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from chatty.memory import (
    MemoryStore,
    SessionCustomerMismatchError,
    SessionNotFoundError,
)


@pytest.fixture
def memory(tmp_path: Path) -> MemoryStore:
    return MemoryStore(tmp_path / "chatty.sqlite")


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
