"""唯一 uvicorn 入口测试（chatty.smoke + 根 main.py 薄壳，decisions §7.3）。"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from chatty import config, smoke
from chatty.smoke import create_smoke_app

REPO_ROOT = Path(__file__).resolve().parents[1]


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


def test_smoke_app_without_built_dist_keeps_api(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """dev 下没有构建 dist：API 照常，未知路径回 404 而不是伺服不存在的 index.html。"""
    monkeypatch.setenv("CHATTY_DATABASE_PATH", str(tmp_path / "smoke.sqlite"))
    monkeypatch.setenv("CHATTY_STATIC_DIR", str(tmp_path / "absent-dist"))

    with TestClient(create_smoke_app()) as client:
        assert client.get("/api/chatty/health").json() == {"status": "ok"}
        assert client.get("/").status_code == 404


def test_empty_database_env_falls_back_to_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """CHATTY_DATABASE_PATH="" 曾解析成仓库根目录本身（sqlite3.connect 拿到目录）。"""
    captured: dict[str, Any] = {}

    def fake_create_app(**kwargs: Any) -> str:
        captured.update(kwargs)
        return "app"

    monkeypatch.setattr(smoke, "create_app", fake_create_app)
    monkeypatch.setenv("CHATTY_DATABASE_PATH", "")
    monkeypatch.setenv("CHATTY_STATIC_DIR", "")

    assert create_smoke_app() == "app"
    assert captured["database_path"] == config.REPO_ROOT / config.DEFAULT_DATABASE_PATH
    assert captured["database_path"] != config.REPO_ROOT
    assert not captured["database_path"].is_dir()


def test_serve_runs_the_same_app_on_localhost(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_run(app: Any, **kwargs: Any) -> None:
        captured["app"] = app
        captured.update(kwargs)

    monkeypatch.setattr(smoke.uvicorn, "run", fake_run)
    monkeypatch.setattr(smoke, "create_smoke_app", lambda: "app")

    smoke.serve()

    assert captured == {"app": "app", "host": "127.0.0.1", "port": 8000}


def test_root_main_is_a_shim_over_the_entry() -> None:
    """根 main.py（pnpm dev:api）只转发 serve，不再自己拼路径。"""
    spec = importlib.util.spec_from_file_location("chatty_root_main", REPO_ROOT / "main.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert module.serve is smoke.serve
