from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Annotated, Literal, Self

from agents import FunctionTool, RunContextWrapper, function_tool
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from chatty.commerce import (
    CommerceError,
    CommerceStore,
    CreateOrderInput,
    FulfillmentMode,
    Order,
)

BusinessOutcome = Literal["verified", "not_completed", "not_applicable"]
MUTATION_TOOLS = frozenset({"create_order", "confirm_order", "cancel_order"})
IsoDateString = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")]


@dataclass(frozen=True)
class BusinessToolReceipt:
    tool_name: str
    ok: bool
    order_id: str | None = None
    expected_status: str | None = None
    evidence: str | None = None
    error: str | None = None


@dataclass
class HarnessContext:
    customer_id: str
    session_id: str
    commerce: CommerceStore
    business_receipts: list[BusinessToolReceipt] = field(default_factory=list)
    prior_actions: list[str] = field(default_factory=list)

    def record_read_success(self, tool_name: str, evidence: str) -> None:
        self.prior_actions.append(f"{tool_name}:ok")
        self.business_receipts.append(
            BusinessToolReceipt(tool_name=tool_name, ok=True, evidence=evidence)
        )

    def record_order_success(self, tool_name: str, order: Order) -> None:
        self.prior_actions.append(f"{tool_name}:ok")
        self.business_receipts.append(
            BusinessToolReceipt(
                tool_name=tool_name,
                ok=True,
                order_id=order.id,
                expected_status=order.status,
            )
        )

    def record_failure(self, tool_name: str, error: Exception) -> None:
        self.prior_actions.append(f"{tool_name}:failed")
        self.business_receipts.append(
            BusinessToolReceipt(tool_name=tool_name, ok=False, error=_error_code(error))
        )

    def verify_business_outcome(self) -> tuple[BusinessOutcome, str | None]:
        if not self.business_receipts:
            return "not_applicable", None
        mutations = [
            receipt for receipt in self.business_receipts if receipt.tool_name in MUTATION_TOOLS
        ]
        latest = mutations[-1] if mutations else self.business_receipts[-1]
        if not latest.ok:
            return "not_completed", f"{latest.tool_name}:{latest.error}"
        if latest.evidence is not None:
            return "verified", latest.evidence
        if latest.order_id is None or latest.expected_status is None:
            raise CommerceError("missing_completion_evidence")
        persisted = self.commerce.get_order(latest.order_id)
        if persisted.status != latest.expected_status:
            raise CommerceError("unverified_business_outcome")
        return (
            "verified",
            f"{latest.tool_name}:{persisted.id}:{persisted.status}",
        )


class _CreateOrderToolInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    idempotency_key: str = Field(min_length=1, max_length=200)
    product_id: str = Field(min_length=1, max_length=100)
    size: str = Field(min_length=1, max_length=40)
    fulfillment_mode: FulfillmentMode
    quantity: int = Field(ge=1, le=100)
    start_date: date | None
    end_date: date | None
    amount_cents: int = Field(gt=0)
    channel: str = Field(default="Chatty", min_length=1, max_length=100)
    address: str = Field(min_length=1, max_length=500)
    risk: str = Field(min_length=1, max_length=500)

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
        start_date: IsoDateString | None,
        end_date: IsoDateString | None,
    ) -> str:
        """Check real SQLite inventory for a rental period or buyout."""
        try:
            availability = context.context.commerce.check_availability(
                product_id=product_id,
                size=size,
                fulfillment_mode=fulfillment_mode,
                quantity=quantity,
                start_date=_parse_date(start_date),
                end_date=_parse_date(end_date),
            )
            context.context.record_read_success(
                "check_availability",
                (
                    f"check_availability:{availability.product_id}:{availability.size}:"
                    f"available={availability.available_quantity}"
                ),
            )
            return _success(availability=availability.model_dump(mode="json"))
        except (CommerceError, ValueError) as error:
            context.context.record_failure("check_availability", error)
            return _failure(error)

    @function_tool
    async def create_order(
        context: RunContextWrapper[HarnessContext],
        idempotency_key: str,
        product_id: str,
        size: str,
        fulfillment_mode: FulfillmentMode,
        quantity: int,
        start_date: IsoDateString | None,
        end_date: IsoDateString | None,
        amount_cents: int,
        address: str,
        risk: str,
        channel: str = "Chatty",
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
            trusted.record_order_success("create_order", order)
            return _success(order=order.model_dump(mode="json"))
        except (CommerceError, ValidationError, ValueError) as error:
            context.context.record_failure("create_order", error)
            return _failure(error)

    @function_tool
    async def view_order(context: RunContextWrapper[HarnessContext], order_id: str) -> str:
        """Read one SQLite order belonging to the trusted customer."""
        try:
            order = _customer_order(context.context, order_id)
            context.context.record_read_success(
                "view_order", f"view_order:{order.id}:{order.status}"
            )
            return _success(order=order.model_dump(mode="json"))
        except CommerceError as error:
            context.context.record_failure("view_order", error)
            return _failure(error)

    @function_tool
    async def confirm_order(context: RunContextWrapper[HarnessContext], order_id: str) -> str:
        """Confirm a trusted customer's order and apply its inventory allocation once."""
        try:
            _customer_order(context.context, order_id)
            order = context.context.commerce.confirm_order(order_id)
            context.context.record_order_success("confirm_order", order)
            return _success(order=order.model_dump(mode="json"))
        except CommerceError as error:
            context.context.record_failure("confirm_order", error)
            return _failure(error)

    @function_tool
    async def cancel_order(context: RunContextWrapper[HarnessContext], order_id: str) -> str:
        """Cancel a trusted customer's order and release its inventory allocation once."""
        try:
            _customer_order(context.context, order_id)
            order = context.context.commerce.cancel_order(order_id)
            context.context.record_order_success("cancel_order", order)
            return _success(order=order.model_dump(mode="json"))
        except CommerceError as error:
            context.context.record_failure("cancel_order", error)
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


def _error_code(error: Exception) -> str:
    if isinstance(error, ValidationError):
        return "invalid_tool_input"
    return str(error)


def _parse_date(value: str | None) -> date | None:
    return date.fromisoformat(value) if value is not None else None
