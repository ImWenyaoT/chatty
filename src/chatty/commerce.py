from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Literal, Self
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

FulfillmentMode = Literal["rental", "buyout"]
OrderStatus = Literal["pending", "confirmed", "cancelled"]


class CommerceError(RuntimeError):
    """A stable, model-visible failure from the bounded commerce backend."""


class CreateOrderInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    idempotency_key: str = Field(min_length=1, max_length=200)
    customer_id: str = Field(min_length=1, max_length=200)
    session_id: str = Field(min_length=1, max_length=200)
    product_id: str = Field(min_length=1, max_length=100)
    size: str = Field(min_length=1, max_length=40)
    fulfillment_mode: FulfillmentMode
    quantity: int = Field(ge=1, le=100)
    start_date: date | None = None
    end_date: date | None = None
    amount_cents: int = Field(default=0, ge=0)
    channel: str = Field(default="Chatty", min_length=1, max_length=100)
    address: str = Field(default="待补充", min_length=1, max_length=500)
    risk: str = Field(default="无", min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_period(self) -> Self:
        if self.fulfillment_mode == "rental":
            if self.start_date is None or self.end_date is None:
                raise ValueError("rental_requires_dates")
            if self.start_date >= self.end_date:
                raise ValueError("invalid_rental_period")
        elif self.start_date is not None or self.end_date is not None:
            raise ValueError("buyout_does_not_accept_dates")
        return self


class Availability(BaseModel):
    product_id: str
    product_name: str
    size: str
    fulfillment_mode: FulfillmentMode
    requested_quantity: int
    available_quantity: int
    available: bool


class OrderEvent(BaseModel):
    id: int
    event_type: Literal["created", "confirmed", "cancelled"]
    description: str
    created_at: str


class Order(BaseModel):
    id: str
    customer_id: str
    session_id: str
    product_id: str
    product_name: str
    size: str
    fulfillment_mode: FulfillmentMode
    quantity: int
    start_date: date | None
    end_date: date | None
    amount_cents: int
    status: OrderStatus
    channel: str
    address: str
    risk: str
    created_at: str
    updated_at: str
    events: list[OrderEvent]


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS product_variants (
    product_id TEXT NOT NULL,
    size TEXT NOT NULL,
    stock INTEGER NOT NULL CHECK (stock >= 0),
    PRIMARY KEY (product_id, size),
    FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    customer_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    size TEXT NOT NULL,
    fulfillment_mode TEXT NOT NULL CHECK (fulfillment_mode IN ('rental', 'buyout')),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    start_date TEXT,
    end_date TEXT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled')),
    channel TEXT NOT NULL,
    address TEXT NOT NULL,
    risk TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (product_id, size) REFERENCES product_variants(product_id, size)
);

CREATE INDEX IF NOT EXISTS idx_orders_availability
    ON orders (product_id, size, status, fulfillment_mode, start_date, end_date);

CREATE TABLE IF NOT EXISTS order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('created', 'confirmed', 'cancelled')),
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (order_id, event_type),
    FOREIGN KEY (order_id) REFERENCES orders(id)
);
"""


class CommerceStore:
    """SQLite source of truth for the MVP's bounded order and inventory behavior."""

    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(SCHEMA)
            connection.execute(
                "INSERT OR IGNORE INTO products (id, name) VALUES (?, ?)",
                ("SUIT-001", "黑色双排扣西装"),
            )
            connection.executemany(
                "INSERT OR IGNORE INTO product_variants (product_id, size, stock) VALUES (?, ?, ?)",
                [("SUIT-001", "M", 1), ("SUIT-001", "L", 2), ("SUIT-001", "XL", 1)],
            )

    def check_availability(
        self,
        *,
        product_id: str,
        size: str,
        quantity: int,
        fulfillment_mode: FulfillmentMode,
        start_date: date | None = None,
        end_date: date | None = None,
        connection: sqlite3.Connection | None = None,
    ) -> Availability:
        if quantity < 1:
            raise CommerceError("invalid_quantity")
        if fulfillment_mode == "rental":
            if start_date is None or end_date is None or start_date >= end_date:
                raise CommerceError("invalid_rental_period")
        elif start_date is not None or end_date is not None:
            raise CommerceError("buyout_does_not_accept_dates")

        normalized_product = product_id.strip().upper()
        normalized_size = size.strip().upper()
        owned_connection = connection is None
        active_connection = connection or self._open_connection()
        try:
            variant = active_connection.execute(
                """
                SELECT products.name, product_variants.stock
                FROM product_variants
                JOIN products ON products.id = product_variants.product_id
                WHERE product_variants.product_id = ? AND product_variants.size = ?
                  AND products.active = 1
                """,
                (normalized_product, normalized_size),
            ).fetchone()
            if variant is None:
                raise CommerceError("unknown_variant")
            reserved = 0
            if fulfillment_mode == "rental":
                assert start_date is not None and end_date is not None
                reserved_row = active_connection.execute(
                    """
                    SELECT COALESCE(SUM(quantity), 0)
                    FROM orders
                    WHERE product_id = ? AND size = ? AND status = 'confirmed'
                      AND fulfillment_mode = 'rental'
                      AND start_date < ? AND end_date > ?
                    """,
                    (
                        normalized_product,
                        normalized_size,
                        end_date.isoformat(),
                        start_date.isoformat(),
                    ),
                ).fetchone()
                reserved = int(reserved_row[0])
            available_quantity = max(0, int(variant["stock"]) - reserved)
            return Availability(
                product_id=normalized_product,
                product_name=str(variant["name"]),
                size=normalized_size,
                fulfillment_mode=fulfillment_mode,
                requested_quantity=quantity,
                available_quantity=available_quantity,
                available=available_quantity >= quantity,
            )
        finally:
            if owned_connection:
                active_connection.close()

    def create_order(self, order_input: CreateOrderInput) -> Order:
        with self._transaction() as connection:
            existing = connection.execute(
                "SELECT id FROM orders WHERE idempotency_key = ?",
                (order_input.idempotency_key,),
            ).fetchone()
            if existing is not None:
                replay = self._get_order(str(existing["id"]), connection)
                if not _same_create_order(replay, order_input):
                    raise CommerceError("idempotency_conflict")
                return replay

            self.check_availability(
                product_id=order_input.product_id,
                size=order_input.size,
                quantity=order_input.quantity,
                fulfillment_mode=order_input.fulfillment_mode,
                start_date=order_input.start_date,
                end_date=order_input.end_date,
                connection=connection,
            )
            order_id = f"order_{uuid4().hex}"
            timestamp = _timestamp()
            connection.execute(
                """
                INSERT INTO orders (
                    id, idempotency_key, customer_id, session_id, product_id, size,
                    fulfillment_mode, quantity, start_date, end_date, amount_cents,
                    status, channel, address, risk, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
                """,
                (
                    order_id,
                    order_input.idempotency_key,
                    order_input.customer_id,
                    order_input.session_id,
                    order_input.product_id.strip().upper(),
                    order_input.size.strip().upper(),
                    order_input.fulfillment_mode,
                    order_input.quantity,
                    order_input.start_date.isoformat() if order_input.start_date else None,
                    order_input.end_date.isoformat() if order_input.end_date else None,
                    order_input.amount_cents,
                    order_input.channel,
                    order_input.address,
                    order_input.risk,
                    timestamp,
                    timestamp,
                ),
            )
            self._record_event(connection, order_id, "created", "订单已创建", timestamp)
            return self._get_order(order_id, connection)

    def confirm_order(self, order_id: str) -> Order:
        with self._transaction() as connection:
            order = self._get_order(order_id, connection)
            if order.status == "confirmed":
                return order
            if order.status != "pending":
                raise CommerceError("order_not_confirmable")
            availability = self.check_availability(
                product_id=order.product_id,
                size=order.size,
                quantity=order.quantity,
                fulfillment_mode=order.fulfillment_mode,
                start_date=order.start_date,
                end_date=order.end_date,
                connection=connection,
            )
            if not availability.available:
                raise CommerceError("insufficient_inventory")
            if order.fulfillment_mode == "buyout":
                result = connection.execute(
                    """
                    UPDATE product_variants SET stock = stock - ?
                    WHERE product_id = ? AND size = ? AND stock >= ?
                    """,
                    (order.quantity, order.product_id, order.size, order.quantity),
                )
                if result.rowcount != 1:
                    raise CommerceError("insufficient_inventory")
            timestamp = _timestamp()
            connection.execute(
                "UPDATE orders SET status = 'confirmed', updated_at = ? WHERE id = ?",
                (timestamp, order_id),
            )
            self._record_event(connection, order_id, "confirmed", "订单已确认", timestamp)
            return self._get_order(order_id, connection)

    def cancel_order(self, order_id: str) -> Order:
        with self._transaction() as connection:
            order = self._get_order(order_id, connection)
            if order.status == "cancelled":
                return order
            if order.status == "confirmed" and order.fulfillment_mode == "buyout":
                connection.execute(
                    """
                    UPDATE product_variants SET stock = stock + ?
                    WHERE product_id = ? AND size = ?
                    """,
                    (order.quantity, order.product_id, order.size),
                )
            timestamp = _timestamp()
            connection.execute(
                "UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?",
                (timestamp, order_id),
            )
            self._record_event(connection, order_id, "cancelled", "订单已取消", timestamp)
            return self._get_order(order_id, connection)

    def get_order(self, order_id: str) -> Order:
        with self._connect() as connection:
            return self._get_order(order_id, connection)

    def list_orders(self) -> list[Order]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id FROM orders ORDER BY updated_at DESC, id DESC"
            ).fetchall()
            return [self._get_order(str(row["id"]), connection) for row in rows]

    def _get_order(self, order_id: str, connection: sqlite3.Connection) -> Order:
        row = connection.execute(
            """
            SELECT orders.*, products.name AS product_name
            FROM orders JOIN products ON products.id = orders.product_id
            WHERE orders.id = ?
            """,
            (order_id,),
        ).fetchone()
        if row is None:
            raise CommerceError("order_not_found")
        events = connection.execute(
            """
            SELECT id, event_type, description, created_at
            FROM order_events WHERE order_id = ? ORDER BY id
            """,
            (order_id,),
        ).fetchall()
        return Order(
            id=str(row["id"]),
            customer_id=str(row["customer_id"]),
            session_id=str(row["session_id"]),
            product_id=str(row["product_id"]),
            product_name=str(row["product_name"]),
            size=str(row["size"]),
            fulfillment_mode=row["fulfillment_mode"],
            quantity=int(row["quantity"]),
            start_date=row["start_date"],
            end_date=row["end_date"],
            amount_cents=int(row["amount_cents"]),
            status=row["status"],
            channel=str(row["channel"]),
            address=str(row["address"]),
            risk=str(row["risk"]),
            created_at=str(row["created_at"]),
            updated_at=str(row["updated_at"]),
            events=[OrderEvent.model_validate(dict(event)) for event in events],
        )

    @staticmethod
    def _record_event(
        connection: sqlite3.Connection,
        order_id: str,
        event_type: str,
        description: str,
        timestamp: str,
    ) -> None:
        connection.execute(
            """
            INSERT OR IGNORE INTO order_events (order_id, event_type, description, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (order_id, event_type, description, timestamp),
        )

    def _open_connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = self._open_connection()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self._open_connection()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()


def _timestamp() -> str:
    return datetime.now(UTC).isoformat()


def _same_create_order(order: Order, requested: CreateOrderInput) -> bool:
    return (
        order.customer_id == requested.customer_id
        and order.session_id == requested.session_id
        and order.product_id == requested.product_id.strip().upper()
        and order.size == requested.size.strip().upper()
        and order.fulfillment_mode == requested.fulfillment_mode
        and order.quantity == requested.quantity
        and order.start_date == requested.start_date
        and order.end_date == requested.end_date
        and order.amount_cents == requested.amount_cents
        and order.channel == requested.channel
        and order.address == requested.address
        and order.risk == requested.risk
    )
