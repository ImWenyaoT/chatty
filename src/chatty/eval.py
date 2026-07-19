from __future__ import annotations

import argparse
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from agents import Model, ModelResponse, ModelSettings, ModelTracing, Usage
from agents.agent_output import AgentOutputSchemaBase
from agents.handoffs import Handoff
from agents.items import TResponseInputItem, TResponseOutputItem, TResponseStreamEvent
from agents.tool import Tool
from fastapi.testclient import TestClient
from openai.types.responses import (
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
)

from chatty.app import create_app


class EvalModel(Model):
    """Deterministic Model boundary; Runner still owns the real Agent Loop."""

    def __init__(self, script: list[dict[str, Any]]) -> None:
        self._script = iter(script)

    async def get_response(
        self,
        system_instructions: str | None,
        input: str | list[TResponseInputItem],
        model_settings: ModelSettings,
        tools: list[Tool],
        output_schema: AgentOutputSchemaBase | None,
        handoffs: list[Handoff],
        tracing: ModelTracing,
        *,
        previous_response_id: str | None,
        conversation_id: str | None,
        prompt: Any,
    ) -> ModelResponse:
        item = next(self._script)
        output: list[TResponseOutputItem]
        if item["type"] == "tool":
            output = [
                ResponseFunctionToolCall(
                    arguments=json.dumps(item["arguments"], ensure_ascii=False),
                    call_id=item["call_id"],
                    name=item["name"],
                    type="function_call",
                )
            ]
        else:
            output = [
                ResponseOutputMessage(
                    id=item["message_id"],
                    content=[
                        ResponseOutputText(annotations=[], text=item["text"], type="output_text")
                    ],
                    role="assistant",
                    status="completed",
                    type="message",
                )
            ]
        return ModelResponse(output=output, usage=Usage(), response_id=None)

    def stream_response(
        self,
        system_instructions: str | None,
        input: str | list[TResponseInputItem],
        model_settings: ModelSettings,
        tools: list[Tool],
        output_schema: AgentOutputSchemaBase | None,
        handoffs: list[Handoff],
        tracing: ModelTracing,
        *,
        previous_response_id: str | None,
        conversation_id: str | None,
        prompt: Any,
    ) -> AsyncIterator[TResponseStreamEvent]:
        raise NotImplementedError


def _read_cases(path: Path) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            case = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid eval JSONL on line {line_number}") from error
        cases.append(case)
    return cases


def _fixed_identity(customer_id: str):
    return lambda: customer_id


def _matches(body: dict[str, Any], expect: dict[str, Any], order_count: int) -> list[str]:
    failures: list[str] = []
    for key in ("status", "business_outcome", "completion_evidence"):
        if key in expect and body.get(key) != expect[key]:
            failures.append(f"{key}: expected {expect[key]!r}, got {body.get(key)!r}")
    if (prefix := expect.get("completion_evidence_prefix")) and not str(
        body.get("completion_evidence") or ""
    ).startswith(prefix):
        failures.append(f"completion_evidence did not start with {prefix!r}")
    if (text := expect.get("reply_contains")) and text not in body.get("reply", ""):
        failures.append(f"reply did not contain {text!r}")
    sources = [record["source"] for record in body.get("knowledge_search_results", [])]
    if "knowledge_sources" in expect and sources != expect["knowledge_sources"]:
        failures.append(
            f"knowledge_sources: expected {expect['knowledge_sources']!r}, got {sources!r}"
        )
    if "order_count" in expect and order_count != expect["order_count"]:
        failures.append(f"order_count: expected {expect['order_count']}, got {order_count}")
    if tool := expect.get("memory_event_tool"):
        tools = [event["tool"] for event in body.get("memory_events", [])]
        if tool not in tools:
            failures.append(f"memory event {tool!r} was not observed")
    if expect.get("memory_source"):
        sources = [
            memory["source_id"]
            for event in body.get("memory_events", [])
            for memory in event["memories"]
        ]
        if not sources:
            failures.append("Memory provenance was not observed")
    if expect.get("support_receipt") and not str(body.get("support_request_id") or "").startswith(
        "support_"
    ):
        failures.append("Handoff receipt was not observed")
    return failures


def run_eval(*, cases_path: Path, output_path: Path, workdir: Path) -> dict[str, int]:
    results: list[dict[str, Any]] = []
    for case in _read_cases(cases_path):
        database_path = workdir / f"{case['id']}.sqlite"
        script = [item for run in case["runs"] for item in run["script"]]
        model = EvalModel(script)
        customer_id = case.get("customer_id", "eval-customer")
        app = create_app(
            database_path=database_path,
            model=model,
            model_id="deterministic-eval-model",
            customer_identity=_fixed_identity(customer_id),
        )
        failures: list[str] = []
        observed_bodies: list[dict[str, Any]] = []
        previous_session: str | None = None
        order_count = 0
        with TestClient(app) as client:
            for run in case["runs"]:
                payload: dict[str, Any] = {"message": run["message"]}
                if run.get("reuse_session"):
                    payload["session_id"] = previous_session
                response = client.post("/runs", json=payload)
                if response.status_code != 200:
                    failures.append(f"Run returned HTTP {response.status_code}: {response.text}")
                    continue
                body = response.json()
                observed_bodies.append(body)
                previous_session = body["session_id"]
                order_count = len(client.get("/orders").json())
                failures.extend(_matches(body, run["expect"], order_count))
        last = observed_bodies[-1] if observed_bodies else {}
        results.append(
            {
                "id": case["id"],
                "passed": not failures,
                "failures": failures,
                "observed": {
                    "status": last.get("status"),
                    "business_outcome": last.get("business_outcome"),
                    "completion_evidence": last.get("completion_evidence"),
                    "knowledge_sources": [
                        record["source"]
                        for body in observed_bodies
                        for record in body.get("knowledge_search_results", [])
                    ],
                    "memory_sources": [
                        memory["source_id"]
                        for body in observed_bodies
                        for event in body.get("memory_events", [])
                        for memory in event["memories"]
                    ],
                    "support_request_id": last.get("support_request_id"),
                    "order_count": order_count,
                },
            }
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        "".join(json.dumps(result, ensure_ascii=False) + "\n" for result in results),
        encoding="utf-8",
    )
    passed = sum(result["passed"] for result in results)
    return {"passed": passed, "failed": len(results) - passed, "total": len(results)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Run deterministic Chatty Agent eval cases")
    parser.add_argument("--cases", type=Path, default=Path("eval/cases.jsonl"))
    parser.add_argument("--output", type=Path, default=Path("eval/results.jsonl"))
    parser.add_argument("--workdir", type=Path, default=Path(".cache/eval"))
    args = parser.parse_args()
    summary = run_eval(cases_path=args.cases, output_path=args.output, workdir=args.workdir)
    print(json.dumps(summary, ensure_ascii=False))
    return 1 if summary["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
