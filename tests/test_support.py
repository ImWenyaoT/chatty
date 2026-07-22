"""SupportRequestStore 契约测试。

覆盖：创建与 trim、prior_actions 紧凑 JSON、幂等重放与同 key 异证据冲突、列表排序。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from chatty.support import SupportRequestIdempotencyConflictError, SupportRequestStore


@pytest.fixture
def support(tmp_path: Path) -> SupportRequestStore:
    return SupportRequestStore(tmp_path / "chatty.sqlite")


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
