from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Self

from agents import FunctionTool, RunContextWrapper, function_tool
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from chatty.commerce import (
    CommerceError,
    CommerceStore,
    CreateOrderInput,
    FulfillmentMode,
    Order,
)


@dataclass(frozen=True)
class HarnessContext:
    customer_id: str
    session_id: str
    commerce: CommerceStore


class _CreateOrderToolInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    idempotency_key: str = Field(min_length=1, max_length=200)
    product_id: str = Field(min_length=1, max_length=100)
    size: str = Field(min_length=1, max_length=40)
    fulfillment_mode: FulfillmentMode
    quantity: int = Field(ge=1, le=100)
    start_date: date | None
    end_date: date | None
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


def build_order_tools() -> list[FunctionTool]:
    @function_tool
    async def check_availability(
        context: RunContextWrapper[HarnessContext],
        product_id: str,
        size: str,
        fulfillment_mode: FulfillmentMode,
        quantity: int,
        start_date: date | None,
        end_date: date | None,
    ) -> str:
        """Check real SQLite inventory for a rental period or buyout."""
        try:
            availability = context.context.commerce.check_availability(
                product_id=product_id,
                size=size,
                fulfillment_mode=fulfillment_mode,
                quantity=quantity,
                start_date=start_date,
                end_date=end_date,
            )
            return _success(availability=availability.model_dump(mode="json"))
        except CommerceError as error:
            return _failure(error)

    @function_tool
    async def create_order(
        context: RunContextWrapper[HarnessContext],
        idempotency_key: str,
        product_id: str,
        size: str,
        fulfillment_mode: FulfillmentMode,
        quantity: int,
        start_date: date | None,
        end_date: date | None,
        amount_cents: int = 0,
        channel: str = "Chatty",
        address: str = "待补充",
        risk: str = "无",
    ) -> str:
        """Create one pending SQLite order with Harness-owned customer and session identity."""
        try:
            trusted = context.context
            raw_arguments = getattr(context, "tool_arguments", "{}")
            validated = _CreateOrderToolInput.model_validate_json(raw_arguments)
            order_input = CreateOrderInput(
                idempotency_key=f"{trusted.session_id}:{validated.idempotency_key}",
                customer_id=trusted.customer_id,
                session_id=trusted.session_id,
                product_id=validated.product_id,
                size=validated.size,
                fulfillment_mode=validated.fulfillment_mode,
                quantity=validated.quantity,
                start_date=validated.start_date,
                end_date=validated.end_date,
                amount_cents=validated.amount_cents,
                channel=validated.channel,
                address=validated.address,
                risk=validated.risk,
            )
            order = trusted.commerce.create_order(order_input)
            return _success(order=order.model_dump(mode="json"))
        except (CommerceError, ValidationError, ValueError) as error:
            return _failure(error)

    @function_tool
    async def view_order(context: RunContextWrapper[HarnessContext], order_id: str) -> str:
        """Read one SQLite order belonging to the trusted customer."""
        try:
            order = _customer_order(context.context, order_id)
            return _success(order=order.model_dump(mode="json"))
        except CommerceError as error:
            return _failure(error)

    @function_tool
    async def confirm_order(context: RunContextWrapper[HarnessContext], order_id: str) -> str:
        """Confirm a trusted customer's order and apply its inventory allocation once."""
        try:
            _customer_order(context.context, order_id)
            order = context.context.commerce.confirm_order(order_id)
            return _success(order=order.model_dump(mode="json"))
        except CommerceError as error:
            return _failure(error)

    @function_tool
    async def cancel_order(context: RunContextWrapper[HarnessContext], order_id: str) -> str:
        """Cancel a trusted customer's order and release its inventory allocation once."""
        try:
            _customer_order(context.context, order_id)
            order = context.context.commerce.cancel_order(order_id)
            return _success(order=order.model_dump(mode="json"))
        except CommerceError as error:
            return _failure(error)

    return [
        check_availability,
        create_order,
        view_order,
        confirm_order,
        cancel_order,
    ]


def _customer_order(context: HarnessContext, order_id: str) -> Order:
    order = context.commerce.get_order(order_id)
    if order.customer_id != context.customer_id:
        raise CommerceError("order_not_found")
    return order


def _success(**payload: object) -> str:
    import json

    return json.dumps({"ok": True, **payload}, ensure_ascii=False)


def _failure(error: Exception) -> str:
    import json

    return json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False)
