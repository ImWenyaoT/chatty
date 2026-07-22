"""CommerceStore 契约测试：种子、CHECK、租期重叠算法、幂等冲突、库存扣减/回补。"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import pytest
from pydantic import ValidationError

from chatty.commerce import CommerceError, CommerceStore, CreateOrderInput


@pytest.fixture
def store(tmp_path: Path) -> CommerceStore:
    return CommerceStore(tmp_path / "chatty.sqlite")


def order_input(**overrides: object) -> CreateOrderInput:
    payload: dict[str, object] = {
        "idempotency_key": "key-1",
        "customer_id": "customer-1",
        "session_id": "session-1",
        "product_id": "SUIT-001",
        "size": "L",
        "fulfillment_mode": "buyout",
        "quantity": 1,
        "amount_cents": 129900,
        "address": "上海市南京西路 1 号",
        "risk": "低风险：老客户",
    }
    payload.update(overrides)
    return CreateOrderInput(**payload)  # type: ignore[arg-type]


def rental_input(**overrides: object) -> CreateOrderInput:
    payload: dict[str, object] = {
        "fulfillment_mode": "rental",
        "start_date": "2026-07-01",
        "end_date": "2026-07-05",
    }
    payload.update(overrides)
    return order_input(**payload)


class TestSeed:
    def test_seed_products_and_variants(self, store: CommerceStore) -> None:
        for size, stock in (("M", 1), ("L", 2), ("XL", 1)):
            availability = store.check_availability(
                product_id="SUIT-001", size=size, quantity=1, fulfillment_mode="buyout"
            )
            assert availability.product_name == "黑色双排扣西装"
            assert availability.available_quantity == stock

    def test_seed_is_idempotent_across_restarts(self, tmp_path: Path) -> None:
        database = tmp_path / "chatty.sqlite"
        first = CommerceStore(database)
        order = first.create_order(order_input(size="M"))
        first.confirm_order(order.id)  # buyout 扣减 M：1 → 0
        first.close()
        second = CommerceStore(database)  # 重启种子 INSERT OR IGNORE，不重置库存
        availability = second.check_availability(
            product_id="SUIT-001", size="M", quantity=1, fulfillment_mode="buyout"
        )
        assert availability.available_quantity == 0
        count = second.database.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        assert count == 1
        second.close()


class TestSchemaChecks:
    def test_orders_check_constraints_reject_bad_rows(self, store: CommerceStore) -> None:
        base = (
            "INSERT INTO orders (id, idempotency_key, customer_id, session_id, product_id, "
            "size, fulfillment_mode, quantity, start_date, end_date, amount_cents, status, "
            "channel, address, risk, created_at, updated_at) "
            "VALUES (?, ?, 'c', 's', 'SUIT-001', 'M', ?, ?, NULL, NULL, ?, ?, "
            "'Chatty', 'a', 'r', 't', 't')"
        )
        with pytest.raises(sqlite3.IntegrityError):  # quantity CHECK (> 0)
            store.database.execute(base, ("o1", "k1", "buyout", 0, 100, "pending"))
        with pytest.raises(sqlite3.IntegrityError):  # status CHECK
            store.database.execute(base, ("o2", "k2", "buyout", 1, 100, "shipped"))
        with pytest.raises(sqlite3.IntegrityError):  # fulfillment_mode CHECK
            store.database.execute(base, ("o3", "k3", "loan", 1, 100, "pending"))
        with pytest.raises(sqlite3.IntegrityError):  # amount_cents CHECK (>= 0)
            store.database.execute(base, ("o4", "k4", "buyout", 1, -1, "pending"))

    def test_composite_foreign_key_enforced(self, store: CommerceStore) -> None:
        statement = (
            "INSERT INTO orders (id, idempotency_key, customer_id, session_id, product_id, "
            "size, fulfillment_mode, quantity, start_date, end_date, amount_cents, status, "
            "channel, address, risk, created_at, updated_at) "
            "VALUES ('o9', 'k9', 'c', 's', 'SUIT-001', 'XXL', 'buyout', 1, NULL, NULL, 100, "
            "'pending', 'Chatty', 'a', 'r', 't', 't')"
        )
        with pytest.raises(sqlite3.IntegrityError):  # (product_id, size) 复合外键
            store.database.execute(statement)

    def test_stock_check_rejects_negative(self, store: CommerceStore) -> None:
        with pytest.raises(sqlite3.IntegrityError):
            store.database.execute(
                "UPDATE product_variants SET stock = -1 WHERE product_id = 'SUIT-001'"
            )

    def test_order_events_unique_per_type(self, store: CommerceStore) -> None:
        order = store.create_order(order_input())
        store.database.execute(
            "INSERT OR IGNORE INTO order_events (order_id, event_type, description, created_at) "
            "VALUES (?, 'created', '重复', 't')",
            (order.id,),
        )
        events = store.get_order(order.id).events
        assert [event.event_type for event in events] == ["created"]
        assert events[0].description == "订单已创建"


class TestCheckAvailability:
    def test_invalid_quantity_checked_first(self, store: CommerceStore) -> None:
        with pytest.raises(CommerceError, match="^invalid_quantity$"):
            store.check_availability(
                product_id="NOPE", size="M", quantity=0, fulfillment_mode="rental"
            )

    def test_rental_period_codes(self, store: CommerceStore) -> None:
        cases = ((None, None), ("2026-07-05", "2026-07-05"), ("2026-07-06", "2026-07-05"))
        for start, end in cases:
            with pytest.raises(CommerceError, match="^invalid_rental_period$"):
                store.check_availability(
                    product_id="SUIT-001",
                    size="M",
                    quantity=1,
                    fulfillment_mode="rental",
                    start_date=start,
                    end_date=end,
                )

    def test_buyout_rejects_dates(self, store: CommerceStore) -> None:
        with pytest.raises(CommerceError, match="^buyout_does_not_accept_dates$"):
            store.check_availability(
                product_id="SUIT-001",
                size="M",
                quantity=1,
                fulfillment_mode="buyout",
                start_date="2026-07-01",
            )

    def test_unknown_variant(self, store: CommerceStore) -> None:
        with pytest.raises(CommerceError, match="^unknown_variant$"):
            store.check_availability(
                product_id="SUIT-999", size="M", quantity=1, fulfillment_mode="buyout"
            )

    def test_inactive_product_is_unknown_variant(self, store: CommerceStore) -> None:
        store.database.execute("UPDATE products SET active = 0 WHERE id = 'SUIT-001'")
        with pytest.raises(CommerceError, match="^unknown_variant$"):
            store.check_availability(
                product_id="SUIT-001", size="M", quantity=1, fulfillment_mode="buyout"
            )

    def test_normalizes_product_and_size(self, store: CommerceStore) -> None:
        availability = store.check_availability(
            product_id=" suit-001 ", size=" l ", quantity=1, fulfillment_mode="buyout"
        )
        assert availability.product_id == "SUIT-001"
        assert availability.size == "L"
        assert availability.available


class TestRentalOverlap:
    """半开区间 [start, end)：existing.start < end AND existing.end > start。"""

    def check(self, store: CommerceStore, start: str, end: str) -> int:
        return store.check_availability(
            product_id="SUIT-001",
            size="L",
            quantity=1,
            fulfillment_mode="rental",
            start_date=start,
            end_date=end,
        ).available_quantity

    def test_confirmed_rental_reserves_overlap_only(self, store: CommerceStore) -> None:
        order = store.create_order(rental_input())  # 2026-07-01 → 2026-07-05，L 库存 2
        assert self.check(store, "2026-07-02", "2026-07-04") == 2  # pending 不占用
        store.confirm_order(order.id)
        assert self.check(store, "2026-07-02", "2026-07-04") == 1  # 区间内
        assert self.check(store, "2026-07-04", "2026-07-08") == 1  # 尾部相交
        assert self.check(store, "2026-06-28", "2026-07-02") == 1  # 头部相交
        assert self.check(store, "2026-07-05", "2026-07-08") == 2  # 相邻：end == start 不算重叠
        assert self.check(store, "2026-06-28", "2026-07-01") == 2  # 相邻（前）
        store.cancel_order(order.id)
        assert self.check(store, "2026-07-02", "2026-07-04") == 2  # cancelled 释放占用

    def test_rental_never_deducts_stock(self, store: CommerceStore) -> None:
        order = store.create_order(rental_input())
        store.confirm_order(order.id)
        row = store.database.execute(
            "SELECT stock FROM product_variants WHERE product_id = 'SUIT-001' AND size = 'L'"
        ).fetchone()
        assert row[0] == 2

    def test_confirm_blocks_on_rental_overlap(self, store: CommerceStore) -> None:
        first = store.create_order(rental_input(idempotency_key="key-a", quantity=2))
        store.confirm_order(first.id)
        second = store.create_order(
            rental_input(idempotency_key="key-b", start_date="2026-07-03", end_date="2026-07-08")
        )
        with pytest.raises(CommerceError, match="^insufficient_inventory$"):
            store.confirm_order(second.id)


class TestCreateOrder:
    def test_creates_pending_with_created_event(self, store: CommerceStore) -> None:
        order = store.create_order(order_input(product_id=" suit-001 ", size=" l "))
        assert order.id.startswith("order_")
        assert order.status == "pending"
        assert order.product_id == "SUIT-001"  # 存规范化后的值
        assert order.size == "L"
        assert order.product_name == "黑色双排扣西装"
        assert [event.event_type for event in order.events] == ["created"]
        assert order.events[0].description == "订单已创建"
        assert order.events[0].created_at == order.created_at
        assert order.created_at == order.updated_at

    def test_shortage_still_creates_pending(self, store: CommerceStore) -> None:
        order = store.create_order(order_input(size="M", quantity=5))  # M 库存 1
        assert order.status == "pending"
        with pytest.raises(CommerceError, match="^insufficient_inventory$"):
            store.confirm_order(order.id)

    def test_idempotent_replay_returns_original(self, store: CommerceStore) -> None:
        first = store.create_order(order_input())
        replay = store.create_order(order_input())
        assert replay == first
        assert len(store.list_orders()) == 1

    def test_idempotency_conflict_on_different_content(self, store: CommerceStore) -> None:
        store.create_order(order_input())
        with pytest.raises(CommerceError, match="^idempotency_conflict$"):
            store.create_order(order_input(address="北京市朝阳区 2 号"))

    def test_replay_ignores_status_change(self, store: CommerceStore) -> None:
        first = store.create_order(order_input())
        store.confirm_order(first.id)
        replay = store.create_order(order_input())  # 状态不参与 sameCreateOrder 比较
        assert replay.id == first.id
        assert replay.status == "confirmed"


class TestConfirmOrder:
    def test_buyout_deducts_stock(self, store: CommerceStore) -> None:
        order = store.create_order(order_input(size="M"))
        confirmed = store.confirm_order(order.id)
        assert confirmed.status == "confirmed"
        assert [event.event_type for event in confirmed.events] == ["created", "confirmed"]
        assert confirmed.events[1].description == "订单已确认"
        row = store.database.execute(
            "SELECT stock FROM product_variants WHERE product_id = 'SUIT-001' AND size = 'M'"
        ).fetchone()
        assert row[0] == 0

    def test_confirm_is_idempotent(self, store: CommerceStore) -> None:
        order = store.create_order(order_input(size="M"))
        first = store.confirm_order(order.id)
        second = store.confirm_order(order.id)
        assert second == first  # 不改 updated_at、不加事件、不重复扣库存
        row = store.database.execute(
            "SELECT stock FROM product_variants WHERE product_id = 'SUIT-001' AND size = 'M'"
        ).fetchone()
        assert row[0] == 0

    def test_cancelled_order_not_confirmable(self, store: CommerceStore) -> None:
        order = store.create_order(order_input())
        store.cancel_order(order.id)
        with pytest.raises(CommerceError, match="^order_not_confirmable$"):
            store.confirm_order(order.id)

    def test_missing_order_not_found(self, store: CommerceStore) -> None:
        with pytest.raises(CommerceError, match="^order_not_found$"):
            store.confirm_order("order_missing")


class TestCancelOrder:
    def stock(self, store: CommerceStore, size: str) -> int:
        row = store.database.execute(
            "SELECT stock FROM product_variants WHERE product_id = 'SUIT-001' AND size = ?",
            (size,),
        ).fetchone()
        return int(row[0])

    def test_cancel_pending_keeps_stock(self, store: CommerceStore) -> None:
        order = store.create_order(order_input(size="M"))
        cancelled = store.cancel_order(order.id)
        assert cancelled.status == "cancelled"
        assert cancelled.events[-1].description == "订单已取消"
        assert self.stock(store, "M") == 1

    def test_cancel_confirmed_buyout_restocks(self, store: CommerceStore) -> None:
        order = store.create_order(order_input(size="M"))
        store.confirm_order(order.id)
        assert self.stock(store, "M") == 0
        store.cancel_order(order.id)
        assert self.stock(store, "M") == 1

    def test_cancel_confirmed_rental_leaves_stock(self, store: CommerceStore) -> None:
        order = store.create_order(rental_input())
        store.confirm_order(order.id)
        store.cancel_order(order.id)
        assert self.stock(store, "L") == 2

    def test_cancel_is_idempotent(self, store: CommerceStore) -> None:
        order = store.create_order(order_input(size="M"))
        store.confirm_order(order.id)
        store.cancel_order(order.id)
        again = store.cancel_order(order.id)
        assert self.stock(store, "M") == 1  # 不重复回补
        assert [event.event_type for event in again.events] == [
            "created",
            "confirmed",
            "cancelled",
        ]


class TestReads:
    def test_get_order_not_found(self, store: CommerceStore) -> None:
        with pytest.raises(CommerceError, match="^order_not_found$"):
            store.get_order("order_missing")

    def test_list_orders_by_updated_desc(self, store: CommerceStore) -> None:
        a = store.create_order(order_input(idempotency_key="key-a"))
        b = store.create_order(order_input(idempotency_key="key-b", size="M"))
        store.confirm_order(a.id)  # 触碰 updated_at，a 应排最前
        assert [order.id for order in store.list_orders()] == [a.id, b.id]

    def test_status_counts_always_has_three_keys(self, store: CommerceStore) -> None:
        assert store.status_counts() == {"pending": 0, "confirmed": 0, "cancelled": 0}
        a = store.create_order(order_input(idempotency_key="key-a"))
        store.create_order(order_input(idempotency_key="key-b", size="M"))
        store.confirm_order(a.id)
        assert store.status_counts() == {"pending": 1, "confirmed": 1, "cancelled": 0}


class TestCreateOrderInputValidation:
    def test_rejects_extra_fields(self) -> None:
        with pytest.raises(ValidationError):
            order_input(unexpected="x")

    def test_quantity_bounds(self) -> None:
        for quantity in (0, 101):
            with pytest.raises(ValidationError):
                order_input(quantity=quantity)

    def test_amount_cents_strictly_positive(self) -> None:
        with pytest.raises(ValidationError):
            order_input(amount_cents=0)

    def test_date_shape_only_no_calendar_validation(self) -> None:
        with pytest.raises(ValidationError):
            rental_input(start_date="2026/07/01")
        # 形状合法即可——2026-02-31 不是合法日历日期，但按裁决只做形状校验
        rental_input(start_date="2026-02-31", end_date="2026-03-01")

    def test_rental_period_cross_field_codes(self) -> None:
        with pytest.raises(ValidationError, match="invalid_rental_period"):
            order_input(fulfillment_mode="rental")
        with pytest.raises(ValidationError, match="invalid_rental_period"):
            rental_input(start_date="2026-07-05", end_date="2026-07-05")
        with pytest.raises(ValidationError, match="buyout_does_not_accept_dates"):
            order_input(start_date="2026-07-01", end_date="2026-07-05")

    def test_lexicographic_date_comparison(self) -> None:
        # 字典序比较（TS 权威）：不做日期解析
        rental_input(start_date="2026-07-09", end_date="2026-07-10")


class TestConcurrency:
    def test_concurrent_creates_are_serialized(self, store: CommerceStore) -> None:
        errors: list[Exception] = []

        def worker(prefix: str) -> None:
            try:
                for index in range(5):
                    store.create_order(order_input(idempotency_key=f"{prefix}-{index}"))
            except Exception as error:  # pragma: no cover - 仅失败时收集
                errors.append(error)

        threads = [threading.Thread(target=worker, args=(prefix,)) for prefix in ("a", "b")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert errors == []
        assert len(store.list_orders()) == 10
