"""失败轨迹与 harvest 的测试。

这条闭环（跑挂了 → 落盘 → 收成回归用例）此前覆盖为 0，而它坏了不会有人发现：
表现是「一直没有失败记录」，看起来跟「一直没失败」一模一样。
"""

from __future__ import annotations

from pathlib import Path

from chatty import config, failure_log
from chatty.models import RecommendationRequest, UserContext
from evals.harvest import harvest, render_harvest_report


def _request(**overrides: object) -> RecommendationRequest:
    fields: dict[str, object] = {"user_id": "user_active", "num_items": 3}
    fields.update(overrides)
    return RecommendationRequest(**fields)  # ty: ignore[invalid-argument-type]


def test_the_log_path_is_absolute(tmp_path: Path, monkeypatch) -> None:
    """路径必须是绝对的：写它的是 demo（任意 cwd），读它的是 evals（仓库根）。

    早先它是相对路径 `.local/failures.jsonl`，于是从别的目录跑 demo 会把失败写到
    那个目录下，而 `--harvest` 从仓库根读——闭环静默断掉，且看不出来。
    """
    assert config.FAILURE_LOG_PATH.is_absolute()

    monkeypatch.chdir(tmp_path)
    log = tmp_path / "elsewhere" / "failures.jsonl"
    failure_log.record(_request(), "invalid_recommendation", path=log)

    # 换个 cwd 再读，读到的还是同一份
    monkeypatch.chdir(tmp_path / "elsewhere")
    assert len(failure_log.read(log)) == 1


def test_a_failure_round_trips(tmp_path: Path) -> None:
    log = tmp_path / "failures.jsonl"
    request = _request(context=UserContext(preferred_categories=["耳机"], max_price_cents=200_000))
    failure_log.record(request, "no_available_recommendations", {"missing": ["P003"]}, path=log)

    entries = failure_log.read(log)
    assert len(entries) == 1
    assert entries[0].error_code == "no_available_recommendations"
    assert entries[0].request["user_id"] == "user_active"
    assert entries[0].request["context"]["preferred_categories"] == ["耳机"]
    assert entries[0].diagnostics == {"missing": ["P003"]}


def test_reading_a_missing_log_is_not_an_error(tmp_path: Path) -> None:
    assert failure_log.read(tmp_path / "nope.jsonl") == []
    assert harvest(tmp_path / "nope.jsonl") == []


def test_a_half_written_line_does_not_lose_the_rest(tmp_path: Path) -> None:
    """Ctrl-C 掉进程会在末尾留半行，不能因为它放弃整份日志。"""
    log = tmp_path / "failures.jsonl"
    failure_log.record(_request(), "invalid_recommendation", path=log)
    with log.open("a", encoding="utf-8") as handle:
        handle.write('{"request": {"user_id": "user_v\n')
    failure_log.record(_request(user_id="user_vip"), "invalid_recommendation", path=log)

    assert [entry.request["user_id"] for entry in failure_log.read(log)] == [
        "user_active",
        "user_vip",
    ]


def test_redacted_fields_never_reach_the_disk(tmp_path: Path) -> None:
    """脱敏在写入时做，不是读的时候做——落过盘就等于泄露过一次。"""
    log = tmp_path / "failures.jsonl"
    failure_log.record(_request(), "invalid_recommendation", path=log)

    raw = log.read_text(encoding="utf-8")
    assert not any(field in raw for field in failure_log.REDACTED_FIELDS)


def test_the_same_pothole_becomes_one_case_with_a_count(tmp_path: Path) -> None:
    """同一个坑踩三次只该产出一条用例，但次数要留着——它说明这条有多值得补。"""
    log = tmp_path / "failures.jsonl"
    tight = _request(context=UserContext(preferred_categories=["耳机"], min_price_cents=5_000_000))
    for _ in range(3):
        failure_log.record(tight, "invalid_recommendation", path=log)
    failure_log.record(_request(user_id="user_vip"), "recommendation_failed", path=log)

    cases = harvest(log)
    assert len(cases) == 2
    # 按出现次数排序，踩得多的排前面
    assert cases[0].seen == 3
    assert cases[0].categories == ("耳机",)
    assert cases[0].min_price_cents == 5_000_000
    assert cases[1].seen == 1
    assert cases[1].user_id == "user_vip"


def test_generated_task_code_is_valid_python(tmp_path: Path) -> None:
    """生成的代码要能直接粘进 dataset.py——语法先得对。"""
    log = tmp_path / "failures.jsonl"
    failure_log.record(
        _request(context=UserContext(preferred_categories=["耳机"], max_price_cents=100)),
        "invalid_recommendation",
        path=log,
    )
    snippet = harvest(log)[0].to_task_code(1)
    compile(f"ALL = (\n{snippet}\n)", "<harvest>", "exec")
    # 期望值要人来确认，不能默认写死
    assert "确认这个请求本就该被拒" in snippet


def test_empty_harvest_tells_you_where_to_look() -> None:
    report = render_harvest_report([])
    assert str(config.FAILURE_LOG_PATH) in report
