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
