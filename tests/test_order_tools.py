import json
from pathlib import Path

import pytest
from agents.tool_context import ToolContext

from chatty.commerce import CommerceStore
from chatty.order_tools import HarnessContext, build_order_tools


def tool_context(context: HarnessContext, name: str, arguments: str) -> ToolContext:
    return ToolContext(
        context,
        tool_name=name,
        tool_call_id=f"call-{name}",
        tool_arguments=arguments,
    )


def test_order_tool_schema_uses_provider_compatible_iso_date_strings() -> None:
    schemas = [tool.params_json_schema for tool in build_order_tools()]

    assert '"format": "date"' not in json.dumps(schemas)
    for tool_name in ("check_availability", "create_order"):
        schema = next(
            tool.params_json_schema for tool in build_order_tools() if tool.name == tool_name
        )
        assert schema["properties"]["start_date"]["anyOf"][0]["type"] == "string"


@pytest.mark.asyncio
async def test_create_order_requires_explicit_business_fields_before_writing(
    tmp_path: Path,
) -> None:
    store = CommerceStore(tmp_path / "chatty.sqlite")
    context = HarnessContext(
        customer_id="trusted-customer",
        session_id="trusted-session",
        commerce=store,
    )
    create_tool = next(tool for tool in build_order_tools() if tool.name == "create_order")

    assert {"amount_cents", "address", "risk"} <= set(create_tool.params_json_schema["required"])
    arguments = json.dumps(
        {
            "idempotency_key": "missing-business-fields",
            "product_id": "SUIT-001",
            "size": "L",
            "fulfillment_mode": "rental",
            "quantity": 1,
            "start_date": "2026-08-01",
            "end_date": "2026-08-03",
        }
    )

    result = await create_tool.on_invoke_tool(
        tool_context(context, "create_order", arguments), arguments
    )

    assert "error" in str(result).lower()
    assert store.list_orders() == []


@pytest.mark.asyncio
async def test_create_order_tool_rejects_model_supplied_identity_before_business_code(
    tmp_path: Path,
) -> None:
    store = CommerceStore(tmp_path / "chatty.sqlite")
    context = HarnessContext(
        customer_id="trusted-customer",
        session_id="trusted-session",
        commerce=store,
    )
    create_tool = next(tool for tool in build_order_tools() if tool.name == "create_order")

    assert "customer_id" not in create_tool.params_json_schema["properties"]
    assert "session_id" not in create_tool.params_json_schema["properties"]
    assert create_tool.params_json_schema["additionalProperties"] is False

    arguments = json.dumps(
        {
            "idempotency_key": "create-1",
            "customer_id": "attacker",
            "product_id": "SUIT-001",
            "size": "L",
            "fulfillment_mode": "rental",
            "quantity": 1,
            "start_date": "2026-08-01",
            "end_date": "2026-08-03",
        }
    )
    result = await create_tool.on_invoke_tool(
        tool_context(context, "create_order", arguments), arguments
    )

    assert "error" in str(result).lower()
    assert store.list_orders() == []


@pytest.mark.asyncio
async def test_order_tools_use_harness_identity_and_return_verified_sqlite_state(
    tmp_path: Path,
) -> None:
    store = CommerceStore(tmp_path / "chatty.sqlite")
    context = HarnessContext(
        customer_id="trusted-customer",
        session_id="trusted-session",
        commerce=store,
    )
    tools = {tool.name: tool for tool in build_order_tools()}
    arguments = json.dumps(
        {
            "idempotency_key": "create-1",
            "product_id": "SUIT-001",
            "size": "L",
            "fulfillment_mode": "rental",
            "quantity": 1,
            "start_date": "2026-08-01",
            "end_date": "2026-08-03",
            "amount_cents": 76000,
            "address": "上海市静安区",
            "risk": "无",
        }
    )

    created = json.loads(
        await tools["create_order"].on_invoke_tool(
            tool_context(context, "create_order", arguments), arguments
        )
    )
    order = store.get_order(created["order"]["id"])

    assert created["ok"] is True
    assert order.customer_id == "trusted-customer"
    assert order.session_id == "trusted-session"
    assert order.status == "pending"

    confirm_arguments = json.dumps({"order_id": order.id})
    confirmed = json.loads(
        await tools["confirm_order"].on_invoke_tool(
            tool_context(context, "confirm_order", confirm_arguments),
            confirm_arguments,
        )
    )
    assert confirmed["order"]["status"] == "confirmed"
    assert store.get_order(order.id).status == "confirmed"


@pytest.mark.asyncio
async def test_successful_read_cannot_hide_a_failed_order_mutation(tmp_path: Path) -> None:
    store = CommerceStore(tmp_path / "chatty.sqlite")
    context = HarnessContext(
        customer_id="trusted-customer",
        session_id="trusted-session",
        commerce=store,
    )
    tools = {tool.name: tool for tool in build_order_tools()}
    create_arguments = json.dumps(
        {
            "idempotency_key": "too-large",
            "product_id": "SUIT-001",
            "size": "L",
            "fulfillment_mode": "buyout",
            "quantity": 3,
            "start_date": None,
            "end_date": None,
            "amount_cents": 10000,
            "channel": "Chatty",
            "address": "上海市静安区",
            "risk": "无",
        }
    )
    created = json.loads(
        await tools["create_order"].on_invoke_tool(
            tool_context(context, "create_order", create_arguments),
            create_arguments,
        )
    )
    order_id = created["order"]["id"]
    order_arguments = json.dumps({"order_id": order_id})

    await tools["confirm_order"].on_invoke_tool(
        tool_context(context, "confirm_order", order_arguments), order_arguments
    )
    await tools["view_order"].on_invoke_tool(
        tool_context(context, "view_order", order_arguments), order_arguments
    )

    assert context.verify_business_outcome() == (
        "not_completed",
        "confirm_order:insufficient_inventory",
    )
