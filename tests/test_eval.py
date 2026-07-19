import json
from pathlib import Path

from chatty.eval import run_eval


def test_deterministic_jsonl_eval_runs_the_real_agent_path(tmp_path: Path) -> None:
    output_path = tmp_path / "results.jsonl"

    summary = run_eval(
        cases_path=Path("eval/cases.jsonl"),
        output_path=output_path,
        workdir=tmp_path,
    )

    assert summary == {"passed": 6, "failed": 0, "total": 6}
    results = [json.loads(line) for line in output_path.read_text().splitlines()]
    assert [result["id"] for result in results] == [
        "ordinary-response",
        "knowledge-with-source",
        "order-side-effect",
        "failed-order-completion-verification",
        "explicit-memory-provenance",
        "handoff-receipt",
    ]
    assert all(result["passed"] for result in results)
    assert results[1]["observed"]["knowledge_sources"] == ["seller-policy://rental-period"]
    assert results[2]["observed"]["order_count"] == 1
    assert results[3]["observed"]["business_outcome"] == "not_completed"
    assert results[4]["observed"]["memory_sources"]
    assert results[5]["observed"]["support_request_id"].startswith("support_")


def test_every_eval_case_is_jsonl_and_declares_observable_expectations() -> None:
    lines = Path("eval/cases.jsonl").read_text(encoding="utf-8").splitlines()

    assert lines
    for line in lines:
        case = json.loads(line)
        assert case["id"]
        assert case["runs"]
        assert all(run["message"] and run["script"] and run["expect"] for run in case["runs"])
