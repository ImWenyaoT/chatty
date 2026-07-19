from datetime import date
from pathlib import Path

import pytest

from chatty.commerce import (
    CommerceError,
    CommerceStore,
    CreateOrderInput,
)


def rental_order(**overrides: object) -> CreateOrderInput:
    values: dict[str, object] = {
        "idempotency_key": "session-1:create-1",
        "customer_id": "customer-1",
        "session_id": "session-1",
        "product_id": "SUIT-001",
        "size": "L",
        "fulfillment_mode": "rental",
        "quantity": 2,
        "start_date": date(2026, 8, 1),
        "end_date": date(2026, 8, 3),
        "amount_cents": 76000,
        "channel": "Chatty",
        "address": "上海市静安区",
        "risk": "无",
    }
    values.update(overrides)
    return CreateOrderInput.model_validate(values)


def test_confirmed_rental_reserves_only_overlapping_dates_and_cancel_releases_it(
    tmp_path: Path,
) -> None:
    store = CommerceStore(tmp_path / "chatty.sqlite")
    order = store.create_order(rental_order())

    store.confirm_order(order.id)

    assert not store.check_availability(
        product_id="SUIT-001",
        size="L",
        quantity=1,
        fulfillment_mode="rental",
        start_date=date(2026, 8, 2),
        end_date=date(2026, 8, 4),
    ).available
    assert store.check_availability(
        product_id="SUIT-001",
        size="L",
        quantity=2,
        fulfillment_mode="rental",
        start_date=date(2026, 8, 3),
        end_date=date(2026, 8, 5),
    ).available

    store.cancel_order(order.id)

    assert store.check_availability(
        product_id="SUIT-001",
        size="L",
        quantity=2,
        fulfillment_mode="rental",
        start_date=date(2026, 8, 2),
        end_date=date(2026, 8, 4),
    ).available
    assert [event.event_type for event in store.get_order(order.id).events] == [
        "created",
        "confirmed",
        "cancelled",
    ]


def test_buyout_confirmation_decrements_stock_once_and_cancel_restores_once(
    tmp_path: Path,
) -> None:
    store = CommerceStore(tmp_path / "chatty.sqlite")
    order = store.create_order(
        rental_order(
            idempotency_key="session-1:buy-1",
            fulfillment_mode="buyout",
            size="M",
            quantity=1,
            start_date=None,
            end_date=None,
        )
    )

    assert store.confirm_order(order.id).status == "confirmed"
    assert store.confirm_order(order.id).status == "confirmed"
    assert (
        store.check_availability(
            product_id="SUIT-001",
            size="M",
            quantity=1,
            fulfillment_mode="buyout",
        ).available_quantity
        == 0
    )

    assert store.cancel_order(order.id).status == "cancelled"
    assert store.cancel_order(order.id).status == "cancelled"
    assert (
        store.check_availability(
            product_id="SUIT-001",
            size="M",
            quantity=1,
            fulfillment_mode="buyout",
        ).available_quantity
        == 1
    )
    assert [event.event_type for event in store.get_order(order.id).events] == [
        "created",
        "confirmed",
        "cancelled",
    ]


def test_create_is_idempotent_and_unknown_or_insufficient_inventory_fails(
    tmp_path: Path,
) -> None:
    store = CommerceStore(tmp_path / "chatty.sqlite")
    first = store.create_order(rental_order())
    replay = store.create_order(rental_order())
    assert replay.id == first.id
    assert len(store.list_orders()) == 1

    with pytest.raises(CommerceError, match="unknown_variant"):
        store.create_order(rental_order(idempotency_key="unknown", size="XXL"))

    too_large = store.create_order(rental_order(idempotency_key="too-large", quantity=3))
    with pytest.raises(CommerceError, match="insufficient_inventory"):
        store.confirm_order(too_large.id)
    assert store.get_order(too_large.id).status == "pending"
