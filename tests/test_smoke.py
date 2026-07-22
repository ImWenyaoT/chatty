"""CI 冒烟工厂测试（chatty.smoke，decisions §7.3）：静态 dist 伺服 + SPA fallback。"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from chatty.smoke import create_smoke_app


def test_smoke_app_serves_static_dist_and_api(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    static_dir = tmp_path / "dist"
    static_dir.mkdir()
    (static_dir / "index.html").write_text(
        "<!doctype html><title>Chatty</title>smoke-index", encoding="utf-8"
    )
    monkeypatch.setenv("CHATTY_DATABASE_PATH", str(tmp_path / "smoke.sqlite"))
    monkeypatch.setenv("CHATTY_STATIC_DIR", str(static_dir))

    with TestClient(create_smoke_app()) as client:
        assert client.get("/api/chatty/health").json() == {"status": "ok"}
        root = client.get("/")
        assert root.status_code == 200
        assert "smoke-index" in root.text
        # decisions §7.3：/orders 等前端路由靠 SPA fallback 回 index.html。
        orders_page = client.get("/orders")
        assert orders_page.status_code == 200
        assert "smoke-index" in orders_page.text
        assert client.get("/api/chatty/orders").json() == []
