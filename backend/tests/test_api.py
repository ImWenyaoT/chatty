from agents.usage import Usage
from fastapi.testclient import TestClient

from app.agent import ChattyContext, ChattyTurn
from app.api import SessionState, create_app
from app.data.catalog import Catalog
from app.data.database import DATA_DIR
from app.data.models import ClarifyReply
from app.model_provider import ResponsesModelProvider
from app.settings import Settings


def test_session_states_have_distinct_locks() -> None:
    first = SessionState(user_id="user_active")
    second = SessionState(user_id="user_active")

    assert first.lock is not second.lock


def test_health_catalog_and_session_validation(tmp_path) -> None:
    catalog = Catalog(tmp_path / "chatty.db", DATA_DIR)
    try:
        with TestClient(create_app(catalog=catalog)) as client:
            assert client.get("/health").json() == {"status": "ok"}
            catalog_response = client.get("/api/catalog")
            assert catalog_response.status_code == 200
            assert catalog_response.json()["product_count"] > 0

            data_response = client.get("/api/catalog/data")
            assert data_response.status_code == 200
            data = data_response.json()
            assert len(data["products"]) == catalog_response.json()["product_count"]
            assert data["products"][0]["product_id"] == "P001"
            assert len(data["profiles"]) == 5
            assert data["profiles"][0]["user_id"] == "user_active"
            assert data["profiles"][0]["display_name"] == "用户 A"
            assert data["profiles"][0]["profile_label"] == "活跃型"

            invalid_user = client.post("/api/sessions", json={"user_id": "missing"})
            assert invalid_user.status_code == 422
            assert invalid_user.json() == {"detail": "unknown_user"}

            session = client.post("/api/sessions", json={"user_id": "user_active"})
            assert session.status_code == 200
            session_id = session.json()["session_id"]

            blank = client.post(
                f"/api/sessions/{session_id}/turns", json={"text": "   "}
            )
            assert blank.status_code == 422
            assert blank.json() == {"detail": "invalid_request"}
    finally:
        catalog.close()


def test_turn_without_credentials_returns_stable_error(tmp_path) -> None:
    catalog = Catalog(tmp_path / "chatty.db", DATA_DIR)
    provider = ResponsesModelProvider(Settings(api_key=""))
    try:
        with TestClient(create_app(catalog=catalog, provider=provider)) as client:
            session = client.post(
                "/api/sessions", json={"user_id": "user_active"}
            ).json()
            response = client.post(
                f"/api/sessions/{session['session_id']}/turns",
                json={"text": "我要一个 200 元的蓝牙耳机"},
            )

            assert response.status_code == 422
            assert response.json() == {"detail": "llm_not_configured"}
    finally:
        catalog.close()


def test_http_adapter_calls_chatty_through_one_turn_interface(tmp_path) -> None:
    class FakeChatty:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str, ChattyContext]] = []

        async def run(
            self, user_id: str, text: str, context: ChattyContext
        ) -> ChattyTurn:
            self.calls.append((user_id, text, context))
            return ChattyTurn(
                reply=ClarifyReply(question="预算可以提高吗？"),
                understood_as="耳机 · ≤200 元",
                context=ChattyContext(pending_user_messages=[text]),
                turns_left=2,
                trace=["task_framing", "evidence_validation"],
                usage=Usage(),
                latency_ms=1,
            )

    catalog = Catalog(tmp_path / "chatty.db", DATA_DIR)
    fake_chatty = FakeChatty()
    try:
        with TestClient(create_app(catalog=catalog, chatty=fake_chatty)) as client:
            session_id = client.post(
                "/api/sessions", json={"user_id": "user_active"}
            ).json()["session_id"]
            response = client.post(
                f"/api/sessions/{session_id}/turns",
                json={"text": "给我一个 200 元的蓝牙耳机"},
            )

        assert response.status_code == 200
        assert response.json()["kind"] == "clarify"
        assert fake_chatty.calls == [
            (
                "user_active",
                "给我一个 200 元的蓝牙耳机",
                ChattyContext(),
            )
        ]
    finally:
        catalog.close()
