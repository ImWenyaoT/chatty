"""browser-smoke 工厂全流程测试（specs/http-contract.md §10、decisions §7.1）。

六步脚本：search → research → content → message（run 1），人工 approve 后
export → message（run 2，复用 session）。
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi.testclient import TestClient

from chatty import browser_smoke

BASE = "/api/chatty"


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


def test_database_path_resolution(tmp_path: Path, monkeypatch) -> None:
    absolute = tmp_path / "abs.sqlite"
    monkeypatch.setenv("CHATTY_E2E_DATABASE", str(absolute))
    assert browser_smoke.browser_smoke_database_path() == absolute
    # 相对路径按仓库根解析；未设置退回旧默认。
    monkeypatch.setenv("CHATTY_E2E_DATABASE", ".cache/custom.sqlite")
    assert (
        browser_smoke.browser_smoke_database_path()
        == browser_smoke.REPO_ROOT / ".cache/custom.sqlite"
    )
    monkeypatch.delenv("CHATTY_E2E_DATABASE", raising=False)
    assert (
        browser_smoke.browser_smoke_database_path()
        == browser_smoke.REPO_ROOT / browser_smoke.DEFAULT_E2E_DATABASE
    )
