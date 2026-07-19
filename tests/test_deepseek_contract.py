import os
from pathlib import Path

from fastapi.testclient import TestClient

from chatty.app import create_app


def test_real_deepseek_completes_a_no_tool_run(
    tmp_path: Path,
) -> None:
    if not os.getenv("OPENAI_API_KEY"):
        raise AssertionError("OPENAI_API_KEY is required for --run-deepseek")

    with TestClient(create_app(database_path=tmp_path / "contract.sqlite")) as client:
        response = client.post("/runs", json={"message": "请只回复 OK"})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "completed"
    assert body["reply"]
    assert body["session_id"].startswith("session_")
    assert body["trace_id"].startswith("trace_")
