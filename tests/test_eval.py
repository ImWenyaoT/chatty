"""Eval lane 测试（specs/runtime-eval.md §7）：金标 7/7、results.jsonl 形状、退出码。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from agents import ModelSettings, ModelTracing

from chatty.eval import (
    EvalExpectation,
    EvalModel,
    MessageScript,
    ToolScript,
    main,
    match_eval_expectation,
    run_eval,
)

REPO_ROOT = Path(__file__).resolve().parents[1]

OBSERVED_KEYS = {
    "status",
    "business_outcome",
    "completion_evidence",
    "knowledge_sources",
    "memory_sources",
    "support_request_id",
    "order_count",
    "artifact_count",
}


async def call_model(model: EvalModel, input_items) -> object:
    return await model.get_response(
        None,
        input_items,
        ModelSettings(),
        [],
        None,
        [],
        ModelTracing.DISABLED,
        previous_response_id=None,
        conversation_id=None,
        prompt=None,
    )


def test_baseline_seven_cases_pass_and_repeat_identically(tmp_path: Path) -> None:
    output_path = tmp_path / "results.jsonl"
    workdir = tmp_path / "work"
    summary = run_eval(
        cases_path=REPO_ROOT / "eval" / "cases.jsonl",
        output_path=output_path,
        workdir=workdir,
    )
    assert summary == {"passed": 7, "failed": 0, "total": 7}
    # 幂等：重复运行结果一致（§7.3 基线）。
    repeated = run_eval(
        cases_path=REPO_ROOT / "eval" / "cases.jsonl",
        output_path=output_path,
        workdir=workdir,
    )
    assert repeated == summary

    results = [
        json.loads(line) for line in output_path.read_text(encoding="utf-8").splitlines()
    ]
    assert len(results) == 7
    assert all(result["passed"] and result["failures"] == [] for result in results)
    assert all(set(result["observed"]) == OBSERVED_KEYS for result in results)
    by_id = {result["id"]: result["observed"] for result in results}

    assert by_id["ordinary-response"]["status"] == "responded"
    assert by_id["ordinary-response"]["order_count"] == 0
    assert by_id["knowledge-with-source"]["knowledge_sources"] == [
        "seller-policy://rental-period"
    ]
    assert by_id["order-side-effect"]["completion_evidence"].startswith("create_order:order_")
    assert by_id["order-side-effect"]["order_count"] == 1
    assert (
        by_id["failed-order-completion-verification"]["completion_evidence"]
        == "create_order:unknown_variant"
    )
    assert by_id["explicit-memory-provenance"]["memory_sources"] != []
    assert by_id["handoff-receipt"]["support_request_id"].startswith("support_")
    industry = by_id["industry-research-to-content"]
    assert industry["completion_evidence"].startswith("artifact:")
    assert industry["artifact_count"] == 2
    assert industry["knowledge_sources"] == ["demo://industry/high-definition-map"]


def test_match_eval_expectation_failure_messages() -> None:
    body = {
        "status": "responded",
        "business_outcome": "not_applicable",
        "completion_evidence": None,
        "reply": "你好",
        "knowledge_search_results": [{"source": "seller-policy://exchange"}],
        "memory_events": [],
        "support_request_id": None,
    }
    expect = EvalExpectation(
        status="completed",
        business_outcome="verified",
        completion_evidence="artifact:x",
        completion_evidence_prefix="artifact:",
        reply_contains="导出",
        knowledge_sources=["demo://industry/high-definition-map"],
        order_count=1,
        artifact_count=2,
        memory_event_tool="save_customer_memory",
        memory_source=True,
        support_receipt=True,
    )
    failures = match_eval_expectation(body, expect, order_count=0, artifact_count=0)
    assert failures == [
        "status: expected 'completed', got 'responded'",
        "business_outcome: expected 'verified', got 'not_applicable'",
        "completion_evidence: expected 'artifact:x', got None",
        "completion_evidence did not start with 'artifact:'",
        "reply did not contain '导出'",
        "knowledge_sources: expected ['demo://industry/high-definition-map'],"
        " got ['seller-policy://exchange']",
        "order_count: expected 1, got 0",
        "artifact_count: expected 2, got 0",
        "memory event 'save_customer_memory' was not observed",
        "Memory provenance was not observed",
        "Handoff receipt was not observed",
    ]
    assert match_eval_expectation(body, EvalExpectation(), 0, 0) == []


async def test_eval_model_script_exhausted_and_placeholder() -> None:
    with pytest.raises(RuntimeError, match="eval script exhausted"):
        await call_model(EvalModel([]), "你好")

    export_script = [
        ToolScript(
            type="tool",
            call_id="c-1",
            name="export_artifact",
            arguments={"artifact_id": "$last_artifact_id", "target": "sandbox"},
        )
    ]
    # input 中没有任何 artifact id → 报错。
    with pytest.raises(RuntimeError, match="eval artifact placeholder missing"):
        await call_model(EvalModel(list(export_script)), "请导出")
    # tool 输出（JSON 字符串）里的 artifact id 会被解析；取最后一个。
    input_items = [
        {"role": "user", "content": "请导出"},
        {
            "type": "function_call_output",
            "call_id": "prev-1",
            "output": '{"ok":true,"artifact":{"id":"artifact_first","kind":"research"}}',
        },
        {
            "type": "function_call_output",
            "call_id": "prev-2",
            "output": '{"ok":true,"artifact":{"id":"artifact_last","kind":"content"}}',
        },
    ]
    response = await call_model(EvalModel(list(export_script)), input_items)
    arguments = json.loads(response.output[0].arguments)
    assert arguments == {"artifact_id": "artifact_last", "target": "sandbox"}

    # message 脚本原样输出文本。
    response = await call_model(
        EvalModel([MessageScript(type="message", message_id="m-1", text="你好")]), "你好"
    )
    assert response.output[0].content[0].text == "你好"


def _write_fixture_repo(tmp_path: Path, expect: dict) -> tuple[Path, Path, Path]:
    case = {
        "id": "fixture-case",
        "runs": [
            {
                "message": "你好",
                "script": [{"type": "message", "message_id": "m-1", "text": "你好。"}],
                "expect": expect,
            }
        ],
    }
    (tmp_path / "eval").mkdir(parents=True, exist_ok=True)
    cases_path = tmp_path / "eval" / "cases.jsonl"
    cases_path.write_text(json.dumps(case, ensure_ascii=False) + "\n", encoding="utf-8")
    (tmp_path / "knowledge").mkdir(exist_ok=True)
    record = {
        "id": "k1",
        "title": "占位",
        "summary": "占位摘要",
        "body": "占位正文",
        "source": "src://1",
        "tags": [],
    }
    (tmp_path / "knowledge" / "records.jsonl").write_text(
        json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return cases_path, tmp_path / "eval" / "results.jsonl", tmp_path / "work"


def test_main_exit_codes_and_summary_line(tmp_path: Path, capsys) -> None:
    cases_path, output_path, workdir = _write_fixture_repo(
        tmp_path, expect={"status": "responded"}
    )
    argv = [
        "--cases", str(cases_path), "--output", str(output_path), "--workdir", str(workdir),
    ]
    assert main(argv) == 0
    assert json.loads(capsys.readouterr().out.strip()) == {
        "passed": 1, "failed": 0, "total": 1,
    }

    failing = tmp_path / "failing"
    cases_path, output_path, workdir = _write_fixture_repo(
        failing, expect={"status": "completed"}
    )
    argv = [
        "--cases", str(cases_path), "--output", str(output_path), "--workdir", str(workdir),
    ]
    assert main(argv) == 1
    assert json.loads(capsys.readouterr().out.strip()) == {
        "passed": 0, "failed": 1, "total": 1,
    }
    result = json.loads(output_path.read_text(encoding="utf-8"))
    assert result["passed"] is False
    assert result["failures"] == ["status: expected 'completed', got 'responded'"]


def test_invalid_jsonl_line_number(tmp_path: Path) -> None:
    cases_path = tmp_path / "cases.jsonl"
    cases_path.write_text("\nnot-json\n", encoding="utf-8")
    with pytest.raises(ValueError, match="invalid eval JSONL on line 2"):
        run_eval(
            cases_path=cases_path,
            output_path=tmp_path / "results.jsonl",
            workdir=tmp_path / "work",
        )
