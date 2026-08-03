from fastapi.testclient import TestClient

from app.api import create_app
from app.catalog import Catalog
from app.database import DATA_DIR


def test_health_catalog_and_session_validation(tmp_path) -> None:
    catalog = Catalog(tmp_path / "chatty.db", DATA_DIR)
    try:
        with TestClient(create_app(catalog=catalog)) as client:
            assert client.get("/health").json() == {"status": "ok"}
            catalog_response = client.get("/api/catalog")
            assert catalog_response.status_code == 200
            assert catalog_response.json()["product_count"] > 0

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
