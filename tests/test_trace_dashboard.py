import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from agents import ModelResponse
from agents.tracing import generation_span
from fastapi.testclient import TestClient
from openai.types.responses import ResponseFunctionToolCall
from test_app import ScriptedModel

from chatty.app import create_app
from chatty.tracing import SQLiteTracingProcessor


class GenerationScriptedModel(ScriptedModel):
    async def get_response(self, *args: Any, **kwargs: Any) -> ModelResponse:
        with generation_span(model="trace-test-model"):
            return await super().get_response(*args, **kwargs)


def test_trace_dashboard_lists_real_runs_and_returns_evidence_detail(tmp_path: Path) -> None:
    model = GenerationScriptedModel(
        [
            ResponseFunctionToolCall(
                arguments=json.dumps({"query": "租期", "limit": 1}, ensure_ascii=False),
                call_id="call-trace-knowledge",
                name="search_knowledge",
                type="function_call",
            ),
            "租期从签收当天开始计算。来源：seller-policy://rental-period",
        ]
    )
    app = create_app(
        database_path=tmp_path / "chatty.sqlite",
        model=model,
        model_id="trace-test-model",
    )

    with TestClient(app) as client:
        run = client.post("/runs", json={"message": "租期怎么算？"})
        dashboard = client.get("/traces")
        detail = client.get(f"/traces/{run.json()['trace_id']}")

    assert run.status_code == 200
    assert dashboard.status_code == 200
    assert dashboard.json()["order_status_counts"] == {
        "pending": 0,
        "confirmed": 0,
        "cancelled": 0,
    }
    assert len(dashboard.json()["traces"]) == 1
    listed = dashboard.json()["traces"][0]
    assert listed["trace_id"] == run.json()["trace_id"]
    assert listed["session_id"] == run.json()["session_id"]
    assert listed["status"] == "completed"
    assert listed["model_id"] == "trace-test-model"
    assert listed["duration_ms"] >= 0
    assert listed["span_types"] == ["agent", "function", "generation", "task", "turn"]

    body = detail.json()
    assert body["business_outcome"] == "not_applicable"
    assert body["completion_evidence"] is None
    assert body["knowledge_sources"] == ["seller-policy://rental-period"]
    assert body["memory_sources"] == []
    assert body["support_request_id"] is None
    assert any(
        span["span_type"] == "function" and "search_knowledge" in span["summary"]
        for span in body["spans"]
    )
    assert all(span["summary"] != "租期怎么算？" for span in body["spans"])
    assert all("签收当天" not in span["summary"] for span in body["spans"])


def test_trace_dashboard_exposes_safe_failure_and_handoff_receipt(tmp_path: Path) -> None:
    model = ScriptedModel(
        [
            ResponseFunctionToolCall(
                arguments=json.dumps({"reason": "需要授权", "context": "退款审批"}),
                call_id="call-trace-handoff",
                name="create_handoff",
                type="function_call",
            ),
            "已转交人工处理。",
        ]
    )
    app = create_app(database_path=tmp_path / "chatty.sqlite", model=model)

    with TestClient(app) as client:
        run = client.post("/runs", json={"message": "请人工处理退款"})
        detail = client.get(f"/traces/{run.json()['trace_id']}")

    body = detail.json()
    assert body["business_outcome"] == "not_completed"
    assert body["completion_evidence"] == f"handoff:{run.json()['support_request_id']}"
    assert body["support_request_id"] == run.json()["support_request_id"]
    assert any(
        span["span_type"] in {"function", "tool"} and span["status"] == "completed"
        for span in body["spans"]
    )


def test_trace_dashboard_allows_real_browser_origin_and_rejects_unknown_origin(
    tmp_path: Path,
) -> None:
    app = create_app(database_path=tmp_path / "chatty.sqlite", model=ScriptedModel(["你好"]))

    with TestClient(app) as client:
        run = client.post("/runs", json={"message": "你好"})
        allowed = client.options(
            "/traces",
            headers={
                "Origin": "http://127.0.0.1:3000",
                "Access-Control-Request-Method": "GET",
            },
        )
        rejected = client.options(
            "/traces",
            headers={
                "Origin": "https://untrusted.example",
                "Access-Control-Request-Method": "GET",
            },
        )
        trace_list = client.get("/traces", headers={"Origin": "http://127.0.0.1:3000"})
        trace_detail = client.get(
            f"/traces/{run.json()['trace_id']}",
            headers={"Origin": "http://127.0.0.1:3000"},
        )

    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "http://127.0.0.1:3000"
    assert "access-control-allow-origin" not in rejected.headers
    assert trace_list.headers["access-control-allow-origin"] == "http://127.0.0.1:3000"
    assert trace_list.json()["traces"][0]["trace_id"] == run.json()["trace_id"]
    assert trace_detail.headers["access-control-allow-origin"] == "http://127.0.0.1:3000"
    assert trace_detail.json()["trace_id"] == run.json()["trace_id"]


def test_app_replaces_the_default_exporter_with_only_the_local_processor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    installed: list[object] = []
    monkeypatch.setattr(
        "chatty.app.set_trace_processors", lambda processors: installed.extend(processors)
    )

    create_app(database_path=tmp_path / "chatty.sqlite", model=ScriptedModel(["你好"]))

    assert len(installed) == 1
    assert isinstance(installed[0], SQLiteTracingProcessor)


def test_trace_dashboard_migrates_the_previous_sqlite_schema_through_public_apis(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "chatty.sqlite"
    with sqlite3.connect(database_path) as connection:
        connection.executescript(
            """
            CREATE TABLE local_traces (
                trace_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                status TEXT NOT NULL,
                summary TEXT NOT NULL,
                model_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE local_spans (
                span_id TEXT PRIMARY KEY,
                trace_id TEXT NOT NULL,
                parent_id TEXT,
                span_type TEXT NOT NULL,
                status TEXT NOT NULL,
                summary TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO local_traces
                (trace_id, session_id, status, summary, model_id)
            VALUES
                ('trace_legacy', 'session_legacy', 'completed',
                 'Agent run completed', 'legacy-model');
            INSERT INTO local_spans
                (span_id, trace_id, parent_id, span_type, status, summary)
            VALUES
                ('span_legacy', 'trace_legacy', NULL, 'agent', 'completed',
                 'agent span completed');
            """
        )

    app = create_app(database_path=database_path, model=ScriptedModel(["你好"]))
    with TestClient(app) as client:
        legacy = client.get("/traces/trace_legacy")
        run = client.post("/runs", json={"message": "你好"})
        current = client.get(f"/traces/{run.json()['trace_id']}")

    assert legacy.status_code == 200
    assert legacy.json()["knowledge_sources"] == []
    assert legacy.json()["memory_sources"] == []
    assert legacy.json()["spans"][0]["started_at"] is None
    assert run.status_code == 200
    assert current.json()["business_outcome"] == "not_applicable"
    assert current.json()["spans"]
