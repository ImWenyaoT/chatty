from pathlib import Path

from fastapi.testclient import TestClient

from chatty.app import create_app
from chatty.demo_data import seed_demo_data


def test_demo_data_is_repeatable_and_visible_through_public_apis(tmp_path: Path) -> None:
    database_path = tmp_path / "chatty.sqlite"

    first = seed_demo_data(database_path)
    second = seed_demo_data(database_path)

    with TestClient(create_app(database_path=database_path)) as client:
        orders = client.get("/orders")
        memories = client.get("/memories", params={"limit": 10})
        support_requests = client.get("/support-requests")
        dashboard = client.get("/traces")

    assert first == second
    assert first.orders == 24
    assert first.memories == 10
    assert first.support_requests == 5
    assert orders.status_code == 200
    assert len(orders.json()) == 24
    assert memories.status_code == 200
    assert len(memories.json()["memories"]) == 10
    assert support_requests.status_code == 200
    assert len(support_requests.json()) == 5
    assert dashboard.json()["order_status_counts"] == {
        "pending": 8,
        "confirmed": 8,
        "cancelled": 8,
    }


def test_customer_memory_search_handles_model_selected_related_terms(tmp_path: Path) -> None:
    database_path = tmp_path / "chatty.sqlite"
    seed_demo_data(database_path)

    with TestClient(create_app(database_path=database_path)) as client:
        response = client.get(
            "/memories",
            params={"query": "尺码 风格偏好 穿衣风格 服装尺码", "limit": 5},
        )

    facts = {item["fact"] for item in response.json()["memories"]}
    assert "常穿 L 码上装" in facts
    assert "偏好深色、低调的商务风格" in facts
