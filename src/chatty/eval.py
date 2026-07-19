from __future__ import annotations

import argparse
import json
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Annotated, Any, Literal

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
from pydantic import BaseModel, ConfigDict, Field, JsonValue

from chatty.app import create_app


class ToolScript(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["tool"]
    call_id: str
    name: str
    arguments: dict[str, JsonValue]


class MessageScript(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["message"]
    message_id: str
    text: str


ScriptItem = Annotated[ToolScript | MessageScript, Field(discriminator="type")]


class EvalExpectation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str | None = None
    business_outcome: str | None = None
    completion_evidence: str | None = None
    completion_evidence_prefix: str | None = None
    reply_contains: str | None = None
    knowledge_sources: list[str] | None = None
    order_count: int | None = None
    memory_event_tool: str | None = None
    memory_source: bool = False
    support_receipt: bool = False


class EvalRun(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str
    script: list[ScriptItem]
    expect: EvalExpectation
    reuse_session: bool = False


class EvalCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    customer_id: str = "eval-customer"
    runs: list[EvalRun]


class EvalObserved(BaseModel):
    status: str | None
    business_outcome: str | None
    completion_evidence: str | None
    knowledge_sources: list[str]
    memory_sources: list[str]
    support_request_id: str | None
    order_count: int


class EvalCaseResult(BaseModel):
    id: str
    passed: bool
    failures: list[str]
    observed: EvalObserved


class EvalModel(Model):
    """Deterministic Model boundary; Runner still owns the real Agent Loop."""

    def __init__(self, script: list[ScriptItem]) -> None:
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
        if isinstance(item, ToolScript):
            output = [
                ResponseFunctionToolCall(
                    arguments=json.dumps(item.arguments, ensure_ascii=False),
                    call_id=item.call_id,
                    name=item.name,
                    type="function_call",
                )
            ]
        else:
            output = [
                ResponseOutputMessage(
                    id=item.message_id,
                    content=[
                        ResponseOutputText(annotations=[], text=item.text, type="output_text")
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


def _read_cases(path: Path) -> list[EvalCase]:
    cases: list[EvalCase] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            case = EvalCase.model_validate_json(line)
        except ValueError as error:
            raise ValueError(f"invalid eval JSONL on line {line_number}") from error
        cases.append(case)
    return cases


def _fixed_identity(customer_id: str) -> Callable[[], str]:
    return lambda: customer_id


def _matches(body: dict[str, Any], expect: EvalExpectation, order_count: int) -> list[str]:
    failures: list[str] = []
    for key in ("status", "business_outcome", "completion_evidence"):
        expected = getattr(expect, key)
        if expected is not None and body.get(key) != expected:
            failures.append(f"{key}: expected {expected!r}, got {body.get(key)!r}")
    if (prefix := expect.completion_evidence_prefix) and not str(
        body.get("completion_evidence") or ""
    ).startswith(prefix):
        failures.append(f"completion_evidence did not start with {prefix!r}")
    if (text := expect.reply_contains) and text not in body.get("reply", ""):
        failures.append(f"reply did not contain {text!r}")
    sources = [record["source"] for record in body.get("knowledge_search_results", [])]
    if expect.knowledge_sources is not None and sources != expect.knowledge_sources:
        failures.append(
            f"knowledge_sources: expected {expect.knowledge_sources!r}, got {sources!r}"
        )
    if expect.order_count is not None and order_count != expect.order_count:
        failures.append(f"order_count: expected {expect.order_count}, got {order_count}")
    if tool := expect.memory_event_tool:
        tools = [event["tool"] for event in body.get("memory_events", [])]
        if tool not in tools:
            failures.append(f"memory event {tool!r} was not observed")
    if expect.memory_source:
        memory_sources = [
            memory["source_id"]
            for event in body.get("memory_events", [])
            for memory in event["memories"]
        ]
        if not memory_sources:
            failures.append("Memory provenance was not observed")
    if expect.support_receipt and not str(body.get("support_request_id") or "").startswith(
        "support_"
    ):
        failures.append("Handoff receipt was not observed")
    return failures


def run_eval(*, cases_path: Path, output_path: Path, workdir: Path) -> dict[str, int]:
    results: list[EvalCaseResult] = []
    for case in _read_cases(cases_path):
        database_path = workdir / f"{case.id}.sqlite"
        model = EvalModel([item for run in case.runs for item in run.script])
        app = create_app(
            database_path=database_path,
            model=model,
            model_id="deterministic-eval-model",
            customer_identity=_fixed_identity(case.customer_id),
        )
        failures: list[str] = []
        observed_bodies: list[dict[str, Any]] = []
        previous_session: str | None = None
        order_count = 0
        with TestClient(app) as client:
            for run in case.runs:
                payload: dict[str, Any] = {"message": run.message}
                if run.reuse_session:
                    payload["session_id"] = previous_session
                response = client.post("/runs", json=payload)
                if response.status_code != 200:
                    failures.append(f"Run returned HTTP {response.status_code}: {response.text}")
                    continue
                body = response.json()
                observed_bodies.append(body)
                previous_session = body["session_id"]
                order_count = len(client.get("/orders").json())
                failures.extend(_matches(body, run.expect, order_count))
        last = observed_bodies[-1] if observed_bodies else {}
        results.append(
            EvalCaseResult(
                id=case.id,
                passed=not failures,
                failures=failures,
                observed=EvalObserved(
                    status=last.get("status"),
                    business_outcome=last.get("business_outcome"),
                    completion_evidence=last.get("completion_evidence"),
                    knowledge_sources=[
                        record["source"]
                        for body in observed_bodies
                        for record in body.get("knowledge_search_results", [])
                    ],
                    memory_sources=[
                        memory["source_id"]
                        for body in observed_bodies
                        for event in body.get("memory_events", [])
                        for memory in event["memories"]
                    ],
                    support_request_id=last.get("support_request_id"),
                    order_count=order_count,
                ),
            )
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        "".join(result.model_dump_json() + "\n" for result in results),
        encoding="utf-8",
    )
    passed = sum(result.passed for result in results)
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
