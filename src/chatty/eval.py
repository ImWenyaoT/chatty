"""确定性 Eval lane（specs/runtime-eval.md §7）：脚本回放 Model + 每用例 SQLite 隔离。

- eval 直调 ChattyRunModule（decisions §5.4，不走 HTTP）；Runner 仍真实执行
  Agent Loop、tool 真实落库，因此 `$last_artifact_id` 能从对话历史里的 tool
  输出（JSON 字符串）解析出来。
- CLI：`uv run python -m chatty.eval`；退出码 0 当且仅当 failed == 0。
"""

from __future__ import annotations

import argparse
import asyncio
import json
from collections.abc import AsyncIterator, Mapping
from pathlib import Path
from typing import Annotated, Any, Literal

from agents import Model, ModelResponse, ModelSettings, ModelTracing, Usage
from agents.agent_output import AgentOutputSchemaBase
from agents.handoffs import Handoff
from agents.items import TResponseInputItem, TResponseOutputItem, TResponseStreamEvent
from agents.tool import Tool
from openai.types.responses import (
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
)
from pydantic import BaseModel, ConfigDict, Field, JsonValue

from chatty import config
from chatty.run import ChattyRunModule
from chatty.runtime import NativeRuntime
from chatty.tools import CHATTY_TOOL_NAMES

ARTIFACT_PLACEHOLDER = "$last_artifact_id"
EVAL_MODEL_ID = "deterministic-eval-model"

# 12 个工具名枚举（§7.2）；与 harness/tools 的声明保持一致（下方 import 时断言）。
ToolName = Literal[
    "search_knowledge",
    "search_customer_memory",
    "save_customer_memory",
    "check_availability",
    "create_order",
    "view_order",
    "confirm_order",
    "cancel_order",
    "create_handoff",
    "save_research_artifact",
    "save_content_artifact",
    "export_artifact",
]

assert set(ToolName.__args__) == set(CHATTY_TOOL_NAMES)  # noqa: S101 — 声明漂移即时爆炸


class ToolScript(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["tool"]
    call_id: str
    name: ToolName
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
    artifact_count: int | None = None
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
    artifact_count: int


class EvalCaseResult(BaseModel):
    id: str
    passed: bool
    failures: list[str]
    observed: EvalObserved


def _scan_artifact_ids(value: object, found: list[str]) -> None:
    """§7.4：递归收集 input 中出现过的 artifact id（后出现者覆盖，取最后一个）。

    以 `{` 开头的字符串先尝试 json.loads 再递归（tool 输出是 JSON 字符串）；
    解析失败静默跳过。
    """
    if isinstance(value, str):
        if value.startswith("{"):
            try:
                parsed = json.loads(value)
            except ValueError:
                return
            _scan_artifact_ids(parsed, found)
        return
    if isinstance(value, Mapping):
        artifact = value.get("artifact")
        if isinstance(artifact, Mapping):
            artifact_id = artifact.get("id")
            if isinstance(artifact_id, str):
                found.append(artifact_id)
        for child in value.values():
            _scan_artifact_ids(child, found)
        return
    if isinstance(value, list | tuple):
        for child in value:
            _scan_artifact_ids(child, found)
        return
    if isinstance(value, BaseModel):
        _scan_artifact_ids(value.model_dump(mode="json"), found)


def _last_artifact_id(input: str | list[TResponseInputItem]) -> str | None:
    found: list[str] = []
    _scan_artifact_ids(input, found)
    return found[-1] if found else None


def _replace_placeholder(value: JsonValue, artifact_id: str | None) -> JsonValue:
    """深度替换恰好等于 `$last_artifact_id` 的字符串；找不到 artifact 则抛错。"""
    if isinstance(value, str):
        if value == ARTIFACT_PLACEHOLDER:
            if artifact_id is None:
                raise RuntimeError("eval artifact placeholder missing")
            return artifact_id
        return value
    if isinstance(value, dict):
        return {key: _replace_placeholder(child, artifact_id) for key, child in value.items()}
    if isinstance(value, list):
        return [_replace_placeholder(child, artifact_id) for child in value]
    return value


class EvalModel(Model):
    """确定性脚本 Model（§7.4）：每次 get_response 消费恰一条脚本。

    脚本 = case 内所有 runs 的 script 按序拼接；Agent Loop 的请求次数与脚本
    条数必须严格一致（耗尽即抛 `eval script exhausted`）。
    """

    def __init__(self, script: list[ScriptItem]) -> None:
        self._script = list(script)
        self._cursor = 0

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
        if self._cursor >= len(self._script):
            raise RuntimeError("eval script exhausted")
        item = self._script[self._cursor]
        self._cursor += 1
        output: list[TResponseOutputItem]
        if isinstance(item, ToolScript):
            arguments = _replace_placeholder(dict(item.arguments), _last_artifact_id(input))
            output = [
                ResponseFunctionToolCall(
                    arguments=json.dumps(arguments, ensure_ascii=False),
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


def match_eval_expectation(
    body: Mapping[str, Any],
    expect: EvalExpectation,
    order_count: int,
    artifact_count: int,
) -> list[str]:
    """§7.6 断言语义；失败文案逐字。body = RunResponse 的 JSON dump。"""
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
    if expect.knowledge_sources is not None:
        sources = [record["source"] for record in body.get("knowledge_search_results", [])]
        if sources != expect.knowledge_sources:
            failures.append(
                f"knowledge_sources: expected {expect.knowledge_sources!r}, got {sources!r}"
            )
    if expect.order_count is not None and order_count != expect.order_count:
        failures.append(f"order_count: expected {expect.order_count}, got {order_count}")
    if expect.artifact_count is not None and artifact_count != expect.artifact_count:
        failures.append(f"artifact_count: expected {expect.artifact_count}, got {artifact_count}")
    if tool := expect.memory_event_tool:
        observed_tools = [event["tool"] for event in body.get("memory_events", [])]
        if tool not in observed_tools:
            failures.append(f"memory event {tool!r} was not observed")
    if expect.memory_source:
        memory_sources = [
            memory["source_id"]
            for event in body.get("memory_events", [])
            for memory in event["memories"]
        ]
        if not any(memory_sources):
            failures.append("Memory provenance was not observed")
    if expect.support_receipt and not str(body.get("support_request_id") or "").startswith(
        "support_"
    ):
        failures.append("Handoff receipt was not observed")
    return failures


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


async def _execute_case(case: EvalCase, *, workdir: Path, knowledge_path: Path) -> EvalCaseResult:
    """§7.5：每用例独立 SQLite + 独立 runtime/run 模块，跑完（finally）关闭。"""
    database_path = workdir / f"{case.id}.sqlite"
    workdir.mkdir(parents=True, exist_ok=True)
    config.reset_database(database_path)
    runtime = NativeRuntime(database_path)
    module = ChattyRunModule(
        runtime,
        model=EvalModel([item for run in case.runs for item in run.script]),
        model_id=EVAL_MODEL_ID,
        knowledge_path=knowledge_path,
    )
    failures: list[str] = []
    bodies: list[dict[str, Any]] = []
    previous_session: str | None = None
    order_count = 0
    artifact_count = 0
    try:
        for index, run in enumerate(case.runs, start=1):
            try:
                response = await module.run(
                    message=run.message,
                    customer_id=case.customer_id,
                    session_id=previous_session if run.reuse_session else None,
                    request_id=f"eval-{case.id}-{index}",
                )
            except Exception as error:  # §7.5 步骤 5：失败记录后继续后续 run
                failures.append(f"Run failed: {error}")
                continue
            body = response.model_dump(mode="json")
            bodies.append(body)
            previous_session = body["session_id"]
            order_count = len(runtime.commerce.list_orders())
            artifact_count = len(runtime.artifacts.list(case.customer_id))
            failures.extend(match_eval_expectation(body, run.expect, order_count, artifact_count))
    finally:
        await module.close()
        runtime.close()
    last = bodies[-1] if bodies else {}
    return EvalCaseResult(
        id=case.id,
        passed=not failures,
        failures=failures,
        observed=EvalObserved(
            status=last.get("status"),
            business_outcome=last.get("business_outcome"),
            completion_evidence=last.get("completion_evidence"),
            knowledge_sources=[
                record["source"]
                for body in bodies
                for record in body.get("knowledge_search_results", [])
            ],
            memory_sources=[
                memory["source_id"]
                for body in bodies
                for event in body.get("memory_events", [])
                for memory in event["memories"]
            ],
            support_request_id=last.get("support_request_id"),
            order_count=order_count,
            artifact_count=artifact_count,
        ),
    )


def run_eval(*, cases_path: Path, output_path: Path, workdir: Path) -> dict[str, int]:
    """跑完所有 case，写 results.jsonl（每 case 一行），返回汇总计数。"""
    cases_path = Path(cases_path)
    # §7.1：知识库跟着 cases 走——`dirname(cases)/..` 就是这次 eval 的仓库根。
    knowledge_path = config.knowledge_path(cases_path.parent.parent)
    results = [
        asyncio.run(_execute_case(case, workdir=Path(workdir), knowledge_path=knowledge_path))
        for case in _read_cases(cases_path)
    ]
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        "".join(result.model_dump_json() + "\n" for result in results),
        encoding="utf-8",
    )
    passed = sum(result.passed for result in results)
    return {"passed": passed, "failed": len(results) - passed, "total": len(results)}


def main(argv: list[str] | None = None) -> int:
    """CLI（§7.1）：stdout 一行汇总 JSON；退出码 0 当且仅当 failed == 0。"""
    parser = argparse.ArgumentParser(description="Run deterministic Chatty Agent eval cases")
    parser.add_argument("--cases", type=Path, default=Path("eval/cases.jsonl"))
    parser.add_argument("--output", type=Path, default=Path("eval/results.jsonl"))
    parser.add_argument("--workdir", type=Path, default=Path(".cache/eval"))
    args = parser.parse_args(argv)
    summary = run_eval(cases_path=args.cases, output_path=args.output, workdir=args.workdir)
    print(json.dumps(summary, ensure_ascii=False))
    return 1 if summary["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
