"""browser-smoke 工厂全流程测试（specs/http-contract.md §10、decisions §7.1）。

六步脚本：search → research → content → message（run 1），人工 approve 后
export → message（run 2，复用 session）。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from chatty import browser_smoke, config

BASE = "/api/chatty"


class _StopBuilding(Exception):
    """哨兵：在应用工厂被调用的那一刻停下，只观察传进去的路径。"""


def test_browser_smoke_six_step_flow(tmp_path: Path, monkeypatch) -> None:
    database_path = tmp_path / "e2e.sqlite"
    database_path.write_text("stale junk", encoding="utf-8")
    monkeypatch.setenv("CHATTY_E2E_DATABASE", str(database_path))
    app = browser_smoke.create_app()
    # §10 步骤 1–2：旧文件被清除，runtime 立即（非懒）构建出全新 SQLite。
    assert database_path.read_bytes().startswith(b"SQLite format 3")
    with TestClient(app) as client:
        assert client.get(f"{BASE}/health").json() == {"status": "ok"}

        # Run 1：search_knowledge → save_research_artifact → save_content_artifact → message。
        run1 = client.post(f"{BASE}/runs", json={"message": "请整理高精地图研究并生成内容"})
        assert run1.status_code == 200
        body1 = run1.json()
        assert body1["customer_id"] == "browser-smoke-customer"
        assert body1["request_id"] == "browser-smoke-request"
        assert body1["status"] == "completed"
        assert body1["business_outcome"] == "verified"
        assert body1["completion_evidence"].startswith("artifact:")
        assert body1["completion_evidence"].endswith(":review_pending")
        assert "等待人工批准" in body1["reply"]
        sources = [record["source"] for record in body1["knowledge_search_results"]]
        assert sources == ["demo://industry/high-definition-map"]

        # 两个 artifact（research + content），content 停在 review_pending。
        artifacts = client.get(f"{BASE}/artifacts").json()
        assert len(artifacts) == 2
        assert {item["kind"] for item in artifacts} == {"research", "content"}
        content = next(item for item in artifacts if item["kind"] == "content")
        assert content["status"] == "review_pending"
        assert content["owner_id"] == "browser-smoke-customer"

        # 人工批准：actor 为 browser-smoke-reviewer。
        approval = client.post(f"{BASE}/artifacts/{content['id']}/approve")
        assert approval.status_code == 200
        assert approval.json()["decision"] == "approved"
        assert approval.json()["actor_id"] == "browser-smoke-reviewer"

        # Run 2（复用 session）：export_artifact($last_artifact_id) → message。
        run2 = client.post(
            f"{BASE}/runs",
            json={"message": "请导出内容包", "session_id": body1["session_id"]},
        )
        assert run2.status_code == 200
        body2 = run2.json()
        assert body2["session_id"] == body1["session_id"]
        assert body2["status"] == "completed"
        assert body2["business_outcome"] == "verified"
        # export 证据格式：delivery:{delivery_id}:{sha256 hex}。
        assert re.fullmatch(
            r"delivery:delivery_[0-9a-f]{32}:[0-9a-f]{64}", body2["completion_evidence"]
        )
        assert "delivery receipt" in body2["reply"]

        # 导出后 content artifact 状态为 exported。
        exported = client.get(f"{BASE}/artifacts", params={"session_id": content["session_id"]})
        statuses = {item["id"]: item["status"] for item in exported.json()}
        assert statuses[content["id"]] == "exported"


def test_factory_takes_paths_from_config(tmp_path: Path, monkeypatch) -> None:
    """路径与清库都来自 chatty.config：本模块只挑脚本模型与固定身份。"""
    captured: dict[str, object] = {}

    def fake_create_http_app(**kwargs: object) -> object:
        captured.update(kwargs)
        raise _StopBuilding

    monkeypatch.setattr(browser_smoke, "create_http_app", fake_create_http_app)
    database_path = tmp_path / "e2e.sqlite"
    for suffix in ("", "-wal", "-shm"):
        Path(f"{database_path}{suffix}").write_text("stale", encoding="utf-8")
    monkeypatch.setenv("CHATTY_E2E_DATABASE", str(database_path))

    with pytest.raises(_StopBuilding):
        browser_smoke.create_app()

    assert captured["database_path"] == config.e2e_database_path() == database_path
    assert captured["knowledge_path"] == config.knowledge_path()
    # §10 步骤 1：db 与 -wal / -shm 旁文件在构建应用之前就已清除。
    assert not any(Path(f"{database_path}{suffix}").exists() for suffix in ("", "-wal", "-shm"))


def test_e2e_database_env_empty_falls_back_to_default(monkeypatch) -> None:
    monkeypatch.setenv("CHATTY_E2E_DATABASE", "")
    assert config.e2e_database_path() == config.REPO_ROOT / config.DEFAULT_E2E_DATABASE_PATH
