"""HTTP 契约测试（specs/http-contract.md、decisions §1）。

覆盖：15 个端点 happy path、枚举错误码、身份注入与欺骗防护、CORS、404/405、
openapi 对齐断言、占位 docs、静态 dist + SPA fallback、lifespan 清理与懒初始化。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from chatty.app import _RUN_FAILURE_STATUS, create_app, run_failure_status
from chatty.artifacts import ArtifactStore
from chatty.commerce import CommerceStore, CreateOrderInput
from chatty.eval import EvalModel, MessageScript
from chatty.harness import AgentRunResult
from chatty.memory import MemoryStore
from chatty.support import SupportRequestStore

BASE = "/api/chatty"

EXPECTED_OPENAPI_PATHS = {
    "/artifacts",
    "/artifacts/{artifact_id}/approve",
    "/health",
    "/memories",
    "/orders",
    "/orders/{order_id}",
    "/runs",
    "/sessions/{session_id}/messages",
    "/support-requests",
    "/support-requests/{support_request_id}",
    "/traces",
    "/traces/{trace_id}",
    "/traces/{trace_id}/spans",
}


def reply_script(text: str = "你好，我可以帮你整理研究资料。") -> list[MessageScript]:
    return [MessageScript(type="message", message_id="m-1", text=text)]


def build_app(database_path: Path, **kwargs):
    kwargs.setdefault("model", EvalModel(reply_script()))
    kwargs.setdefault("model_id", "test-model")
    return create_app(database_path=database_path, **kwargs)


@pytest.fixture
def database_path(tmp_path: Path) -> Path:
    return tmp_path / "app.sqlite"


def test_health_and_docs_do_not_initialize_runtime(database_path: Path) -> None:
    app = build_app(database_path)
    with TestClient(app) as client:
        assert client.get(f"{BASE}/health").json() == {"status": "ok"}
        assert client.get(f"{BASE}/health").status_code == 200
        assert client.get(f"{BASE}/openapi.json").status_code == 200
        assert client.get(f"{BASE}/docs").status_code == 200
        assert client.get(f"{BASE}/redoc").status_code == 200
        # §1.2 懒初始化：以上端点不得打开 SQLite。
        assert not database_path.exists()


def test_run_happy_path_ignores_spoofed_identity(database_path: Path) -> None:
    app = build_app(database_path)
    with TestClient(app) as client:
        response = client.post(
            f"{BASE}/runs",
            json={
                "message": "你好",
                "session_id": None,
                "customer_id": "spoofed-customer",
                "request_id": "spoofed-request",
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["customer_id"] == "demo-customer"
        assert body["request_id"].startswith("request_")
        assert body["request_id"] != "spoofed-request"
        assert body["session_id"].startswith("session_")
        assert body["trace_id"].startswith("trace_")
        assert body["status"] == "responded"
        assert body["business_outcome"] == "not_applicable"
        assert body["reply"] == "你好，我可以帮你整理研究资料。"
        assert body["completion_evidence"] is None
        assert body["knowledge_search_results"] == []
        assert body["memory_events"] == []
        assert body["needs_human"] is False
        assert body["support_request_id"] is None


def test_run_request_validation_native_422(database_path: Path) -> None:
    app = build_app(database_path)
    with TestClient(app) as client:
        # message 缺失。
        response = client.post(f"{BASE}/runs", json={})
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert isinstance(detail, list)
        assert detail[0]["loc"] == ["body", "message"]
        assert detail[0]["type"] == "missing"
        # message 空串。
        response = client.post(f"{BASE}/runs", json={"message": ""})
        entry = response.json()["detail"][0]
        assert response.status_code == 422
        assert entry["type"] == "string_too_short"
        assert entry["ctx"]["min_length"] == 1
        # message 非字符串。
        response = client.post(f"{BASE}/runs", json={"message": 42})
        assert response.status_code == 422
        assert response.json()["detail"][0]["type"] == "string_type"
        # session_id 空串。
        response = client.post(f"{BASE}/runs", json={"message": "你好", "session_id": ""})
        entry = response.json()["detail"][0]
        assert response.status_code == 422
        assert entry["loc"] == ["body", "session_id"]
        assert entry["type"] == "string_too_short"
        # 空 body 与非法 JSON。
        headers = {"content-type": "application/json"}
        response = client.post(f"{BASE}/runs", content=b"", headers=headers)
        assert response.status_code == 422
        assert response.json()["detail"][0]["loc"] == ["body"]
        response = client.post(f"{BASE}/runs", content=b"{", headers=headers)
        assert response.status_code == 422
        assert response.json()["detail"][0]["type"] == "json_invalid"
        # JSON 数组 body。
        response = client.post(f"{BASE}/runs", json=[1, 2])
        assert response.status_code == 422
        assert response.json()["detail"][0]["loc"] == ["body"]


def test_run_failure_status_mapping(database_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    # session_not_found（校验期，无 trace）→ 409。
    app = build_app(database_path)
    with TestClient(app) as client:
        response = client.post(f"{BASE}/runs", json={"message": "你好", "session_id": "missing"})
        assert response.status_code == 409
        assert response.json() == {"detail": "session_not_found"}
        assert "x-trace-id" not in response.headers
        # session_customer_mismatch → 409。
        store = MemoryStore(database_path)
        store.bind_session(session_id="alien-session", customer_id="other-customer")
        store.close()
        response = client.post(
            f"{BASE}/runs", json={"message": "你好", "session_id": "alien-session"}
        )
        assert response.status_code == 409
        assert response.json() == {"detail": "session_customer_mismatch"}
    # llm_not_configured（懒构造 run 模块时抛）→ 503；不跑 Agent 的端点不受影响。
    app = create_app(database_path=database_path)
    with TestClient(app) as client:
        response = client.post(f"{BASE}/runs", json={"message": "你好"})
        assert response.status_code == 503
        assert response.json() == {"detail": "llm_not_configured"}
        assert client.get(f"{BASE}/orders").status_code == 200
        # 会话历史是只读 store 概念：缺 key 也必须给真实答案，绝不 503。
        store = MemoryStore(database_path)
        store.bind_session(session_id="keyless-session", customer_id="demo-customer")
        store.close()
        history = client.get(f"{BASE}/sessions/keyless-session/messages")
        assert history.status_code == 200
        assert history.json() == {"session_id": "keyless-session", "messages": []}
        # 属主类错误仍按会话语义映射，同样不是 503。
        assert client.get(f"{BASE}/sessions/never-issued/messages").status_code == 404
        assert client.get(f"{BASE}/sessions/alien-session/messages").status_code == 409
    # llm_provider_failed（脚本耗尽 → 任意异常）→ 502 + x-trace-id。
    app = build_app(database_path, model=EvalModel([]))
    with TestClient(app) as client:
        response = client.post(f"{BASE}/runs", json={"message": "你好"})
        assert response.status_code == 502
        assert response.json() == {"detail": "llm_provider_failed"}
        assert response.headers["x-trace-id"].startswith("trace_")


def test_outcome_violation_returns_500_with_trace_id(database_path: Path, monkeypatch) -> None:
    """出站不变量违约不再是裸 500：经 RunFailure 出场，带 X-Trace-ID，trace 记为 failed。"""

    def broken_result(context, **_):
        return AgentRunResult(
            reply="好的。",
            knowledge_search_results=[],
            memory_events=[],
            business_outcome="verified",
            completion_evidence=None,
            support_request_id=None,
        )

    monkeypatch.setattr("chatty.run.complete_agent_run", broken_result)
    app = build_app(database_path)
    with TestClient(app) as client:
        response = client.post(f"{BASE}/runs", json={"message": "你好"})
        assert response.status_code == 500
        assert response.json() == {"detail": "run_contract_violated"}
        trace_id = response.headers["x-trace-id"]
        assert trace_id.startswith("trace_")
        detail = client.get(f"{BASE}/traces/{trace_id}")
        assert detail.status_code == 200
        assert detail.json()["status"] == "failed"


def test_session_messages(database_path: Path) -> None:
    app = build_app(database_path)
    with TestClient(app) as client:
        session_id = client.post(f"{BASE}/runs", json={"message": "你好"}).json()["session_id"]
        response = client.get(f"{BASE}/sessions/{session_id}/messages")
        assert response.status_code == 200
        body = response.json()
        assert body["session_id"] == session_id
        assert len(body["messages"]) >= 2
        assert all(isinstance(item, dict) for item in body["messages"])
        # session_not_found 在此映射 404（与 /runs 的 409 不同）。
        response = client.get(f"{BASE}/sessions/never-issued/messages")
        assert response.status_code == 404
        assert response.json() == {"detail": "session_not_found"}
        store = MemoryStore(database_path)
        store.bind_session(session_id="alien-session", customer_id="other-customer")
        store.close()
        response = client.get(f"{BASE}/sessions/alien-session/messages")
        assert response.status_code == 409
        assert response.json() == {"detail": "session_customer_mismatch"}


def test_orders_endpoints(database_path: Path) -> None:
    commerce = CommerceStore(database_path)
    order = commerce.create_order(
        CreateOrderInput(
            idempotency_key="test-order-1",
            customer_id="demo-customer",
            session_id="sess-1",
            product_id="SUIT-001",
            size="L",
            fulfillment_mode="rental",
            quantity=1,
            start_date="2026-08-01",
            end_date="2026-08-03",
            amount_cents=76000,
            address="上海市静安区",
            risk="无",
        )
    )
    commerce.close()
    app = build_app(database_path)
    with TestClient(app) as client:
        listed = client.get(f"{BASE}/orders")
        assert listed.status_code == 200
        assert [item["id"] for item in listed.json()] == [order.id]
        got = client.get(f"{BASE}/orders/{order.id}")
        assert got.status_code == 200
        assert got.json()["status"] == "pending"
        missing = client.get(f"{BASE}/orders/nope")
        assert missing.status_code == 404
        assert missing.json() == {"detail": "order_not_found"}


def _research_payload(key: str) -> dict:
    return {
        "idempotency_key": key,
        "title": "研究简报",
        "summary": "摘要。",
        "claims": [{"id": "c1", "text": "事实句。", "source_ids": ["k1"]}],
        "nodes": [],
        "relations": [],
        "unknowns": [],
    }


def test_artifacts_list_and_approve(database_path: Path) -> None:
    store = ArtifactStore(database_path)
    reviewed = store.create_research(
        owner_id="demo-customer", session_id="sess-a", **_research_payload("r1")
    )
    store.review(reviewed.id)  # → review_pending
    draft = store.create_research(
        owner_id="demo-customer", session_id="sess-b", **_research_payload("r2")
    )
    foreign = store.create_research(
        owner_id="other-owner", session_id="sess-x", **_research_payload("r3")
    )
    store.review(foreign.id)
    store.close()
    app = build_app(database_path)
    with TestClient(app) as client:
        # 按客户身份过滤（other-owner 不可见）；session_id 二次过滤。
        listed = client.get(f"{BASE}/artifacts")
        assert listed.status_code == 200
        assert {item["id"] for item in listed.json()} == {reviewed.id, draft.id}
        filtered = client.get(f"{BASE}/artifacts", params={"session_id": "sess-a"})
        assert [item["id"] for item in filtered.json()] == [reviewed.id]
        # 成功批准。
        approved = client.post(f"{BASE}/artifacts/{reviewed.id}/approve")
        assert approved.status_code == 200
        body = approved.json()
        assert body["artifact_id"] == reviewed.id
        assert body["decision"] == "approved"
        assert body["actor_id"] == "demo-reviewer"
        # 幂等：重复批准返回同一 approval。
        again = client.post(f"{BASE}/artifacts/{reviewed.id}/approve")
        assert again.status_code == 200
        assert again.json()["id"] == body["id"]
        # 未 review → 409；owner 不匹配 / 不存在 → 404。
        response = client.post(f"{BASE}/artifacts/{draft.id}/approve")
        assert response.status_code == 409
        assert response.json() == {"detail": "artifact_not_reviewed"}
        response = client.post(f"{BASE}/artifacts/{foreign.id}/approve")
        assert response.status_code == 404
        assert response.json() == {"detail": "artifact_not_found"}
        response = client.post(f"{BASE}/artifacts/never/approve")
        assert response.status_code == 404
        assert response.json() == {"detail": "artifact_not_found"}


def test_memories_search_and_limit(database_path: Path) -> None:
    store = MemoryStore(database_path)
    store.save(customer_id="demo-customer", fact="我对羊毛过敏", source_id="req-1")
    store.close()
    app = build_app(database_path)
    with TestClient(app) as client:
        response = client.get(f"{BASE}/memories", params={"query": "羊毛", "limit": "5"})
        assert response.status_code == 200
        body = response.json()
        assert body["customer_id"] == "demo-customer"
        assert body["query"] == "羊毛"
        assert [memory["fact"] for memory in body["memories"]] == ["我对羊毛过敏"]
        # 缺省 query=""、limit=10。
        assert client.get(f"{BASE}/memories").status_code == 200
        # 非法 limit → 业务字符串 detail（§6，非原生数组格式）。
        for bad in ("11", "0", "abc", "2.5"):
            response = client.get(f"{BASE}/memories", params={"limit": bad})
            assert response.status_code == 422
            assert response.json() == {"detail": "invalid_memory_limit"}


def test_support_requests(database_path: Path) -> None:
    store = SupportRequestStore(database_path)
    created = store.create(
        customer_id="demo-customer",
        session_id="sess-1",
        reason="需要人工授权",
        context="退款审批",
        model_context="模型上下文",
        prior_actions=["create_order:failed"],
        idempotency_key="key-1",
    )
    store.close()
    app = build_app(database_path)
    with TestClient(app) as client:
        listed = client.get(f"{BASE}/support-requests")
        assert listed.status_code == 200
        assert [item["id"] for item in listed.json()] == [created.id]
        got = client.get(f"{BASE}/support-requests/{created.id}")
        assert got.status_code == 200
        assert got.json()["reason"] == "需要人工授权"
        missing = client.get(f"{BASE}/support-requests/nope")
        assert missing.status_code == 404
        assert missing.json() == {"detail": "support_request_not_found"}


def test_traces_dashboard_and_detail(database_path: Path) -> None:
    app = build_app(database_path)
    with TestClient(app) as client:
        trace_id = client.post(f"{BASE}/runs", json={"message": "你好"}).json()["trace_id"]
        dashboard = client.get(f"{BASE}/traces")
        assert dashboard.status_code == 200
        body = dashboard.json()
        assert body["order_status_counts"] == {"pending": 0, "confirmed": 0, "cancelled": 0}
        listed = {trace["trace_id"]: trace for trace in body["traces"]}
        assert trace_id in listed
        assert listed[trace_id]["spans"] == []  # 列表页恒为 []
        assert "agent" in listed[trace_id]["span_types"]
        assert listed[trace_id]["status"] == "completed"
        detail = client.get(f"{BASE}/traces/{trace_id}")
        assert detail.status_code == 200
        assert len(detail.json()["spans"]) >= 1
        spans = client.get(f"{BASE}/traces/{trace_id}/spans")
        assert spans.status_code == 200
        assert [span["trace_id"] for span in spans.json()] == [trace_id] * len(spans.json())
        # 404 与非法 limit。
        assert client.get(f"{BASE}/traces/none").status_code == 404
        assert client.get(f"{BASE}/traces/none").json() == {"detail": "trace_not_found"}
        assert client.get(f"{BASE}/traces/none/spans").status_code == 404
        for bad in ("0", "101", "abc"):
            response = client.get(f"{BASE}/traces", params={"limit": bad})
            assert response.status_code == 422
            assert response.json() == {"detail": "invalid_trace_limit"}


def test_cors_policy(database_path: Path) -> None:
    app = build_app(database_path)
    with TestClient(app) as client:
        allowed = client.get(f"{BASE}/health", headers={"Origin": "http://localhost:3000"})
        assert allowed.headers["access-control-allow-origin"] == "http://localhost:3000"
        denied = client.get(f"{BASE}/health", headers={"Origin": "http://evil.example"})
        assert "access-control-allow-origin" not in denied.headers
        preflight = client.options(
            f"{BASE}/runs",
            headers={
                "Origin": "http://127.0.0.1:3000",
                "Access-Control-Request-Method": "POST",
            },
        )
        assert preflight.status_code == 200
        assert preflight.headers["access-control-allow-origin"] == "http://127.0.0.1:3000"
        assert "POST" in preflight.headers["access-control-allow-methods"]


def test_unknown_path_404_and_wrong_method_405(database_path: Path) -> None:
    app = build_app(database_path)
    with TestClient(app) as client:
        response = client.get(f"{BASE}/nope")
        assert response.status_code == 404
        assert response.json() == {"detail": "Not Found"}
        assert client.get("/totally/unknown").status_code == 404
        response = client.put(f"{BASE}/health")
        assert response.status_code == 405
        assert response.json() == {"detail": "Method Not Allowed"}
        assert client.delete(f"{BASE}/runs").status_code == 405
        # 默认（无静态兜底）模式：未知路径的非 GET 请求本来就是 404。
        assert client.post("/foo").status_code == 404


def test_openapi_document_alignment(database_path: Path) -> None:
    app = build_app(database_path)
    with TestClient(app) as client:
        document = client.get(f"{BASE}/openapi.json").json()
        assert document["info"]["title"] == "Chatty Agent"
        assert document["info"]["version"] == "0.1.0"
        assert document["servers"] == [{"url": "/api/chatty"}]
        assert set(document["paths"]) == EXPECTED_OPENAPI_PATHS


def test_docs_placeholder_html(database_path: Path) -> None:
    app = build_app(database_path)
    with TestClient(app) as client:
        for path, kind in ((f"{BASE}/docs", "swagger"), (f"{BASE}/redoc", "redoc")):
            response = client.get(path)
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/html")
            assert 'href="/api/chatty/openapi.json"' in response.text
            assert f"{kind} documentation" in response.text


def test_static_dist_with_spa_fallback(database_path: Path, tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<h1>Chatty dist</h1>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    app = build_app(database_path, static_dir=dist)
    with TestClient(app) as client:
        assert "Chatty dist" in client.get("/").text
        # SPA fallback：前端路由回 index.html。
        assert "Chatty dist" in client.get("/orders").text
        assert client.get("/assets/app.js").text == "console.log(1)"
        # API 前缀下未知路径保持 JSON 404。
        response = client.get(f"{BASE}/nope")
        assert response.status_code == 404
        assert response.json() == {"detail": "Not Found"}
        # API 路由不被静态兜底遮蔽。
        assert client.get(f"{BASE}/health").json() == {"status": "ok"}
        # 未知路径的非 GET 请求：不被 GET catch-all 顶成 405，仍回 JSON 404。
        for path in ("/foo", "/orders"):
            response = client.post(path)
            assert response.status_code == 404
            assert response.json() == {"detail": "Not Found"}
        # 已注册 API 路径的方法不匹配保持 405。
        response = client.delete(f"{BASE}/orders")
        assert response.status_code == 405
        assert response.json() == {"detail": "Method Not Allowed"}


def test_lifespan_closes_run_module_and_runtime(database_path: Path) -> None:
    app = build_app(database_path)
    with TestClient(app) as client:
        assert client.get(f"{BASE}/orders").status_code == 200
        runtime = app.state.services.runtime()
    with pytest.raises(sqlite3.ProgrammingError):
        runtime.commerce.database.execute("SELECT 1")


def test_run_failure_status_table_and_route_override() -> None:
    """状态映射归传输层：全表、未知 code 与路由级 override 都在这里裁决。"""
    assert _RUN_FAILURE_STATUS == {
        "session_not_found": 409,
        "session_customer_mismatch": 409,
        "llm_not_configured": 503,
        "handoff_idempotency_conflict": 409,
        "handoff_persistence_failed": 500,
        "llm_provider_failed": 502,
        "run_contract_violated": 500,
    }
    assert run_failure_status("handoff_idempotency_conflict") == 409
    assert run_failure_status("anything_unknown") == 502
    # GET /sessions/{id}/messages 的差异现在是调用点传入的参数，
    # 不再是 Harness 里一条指向调用者的注释。
    assert run_failure_status("session_not_found") == 409
    assert run_failure_status("session_not_found", {"session_not_found": 404}) == 404
    assert run_failure_status("llm_not_configured", {"session_not_found": 404}) == 503
