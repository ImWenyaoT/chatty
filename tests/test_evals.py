"""评估框架自身的测试。

评估器也是代码，也会有 bug。如果评分逻辑写错了，评估结论就是错的——
所以先用脚本化模型把评估框架本身验证一遍，再去跑真实模型。
"""

from __future__ import annotations

import pytest

from chatty.models import (
    RecommendationResponse,
    RecommendedProduct,
)
from evals.dataset import ALL_TASKS, Expect, Level, tasks_by_level
from evals.report import summarize
from evals.rubric import grade
from evals.runner import EvalRun


def _product(
    product_id: str = "P003",
    *,
    price_cents: int = 189900,
    stock: int = 100,
    category: str = "耳机",
    reason: str = "降噪效果适合地铁通勤使用",
    copy: str = "通勤路上也能安静下来的一副耳机",
) -> RecommendedProduct:
    return RecommendedProduct(
        product_id=product_id,
        name="AirPods Pro 3",
        category=category,
        price_cents=price_cents,
        brand="Apple",
        stock=stock,
        tags=["降噪"],
        score=0.9,
        low_stock=stock <= 100,
        reason=reason,
        marketing_copy=copy,
    )


def _response(*products: RecommendedProduct) -> RecommendationResponse:
    return RecommendationResponse(
        request_id="request_test",
        user_id="user_active",
        products=list(products),
        total_latency_ms=12.0,
    )


def _task(task_id: str):
    return next(task for task in ALL_TASKS if task.task_id == task_id)


def test_every_task_has_a_machine_checkable_expectation() -> None:
    """数据集自检：期望拒绝的任务必须给出允许的错误码，否则无法判定。"""
    assert ALL_TASKS
    for task in ALL_TASKS:
        assert task.intent, f"{task.task_id} 缺少意图说明"
        if task.expect is Expect.REFUSE:
            assert task.allowed_error_codes, f"{task.task_id} 期望拒绝却未声明错误码"
        else:
            # 期望成功的任务至少要有一项可验证约束，否则等于没测
            assert (
                task.required_categories
                or task.banned_product_ids
                or task.max_price_cents
                or task.min_price_cents
                or task.num_items
            ), f"{task.task_id} 没有任何可验证约束"


def test_task_levels_are_all_populated() -> None:
    for level in Level:
        assert tasks_by_level(level), f"{level} 没有任何任务"


def test_success_task_passes_when_everything_is_correct() -> None:
    verdict = grade(
        _task("L1-earphone-active"),
        response=_response(_product()),
        error_code=None,
        forbidden_words=["绝对", "100%"],
        latency_ms=10.0,
    )
    assert verdict.passed
    assert verdict.veto is None


def test_forbidden_word_triggers_veto() -> None:
    """否决项：文案里出现禁词，不管其他维度多好都直接判负。"""
    verdict = grade(
        _task("L1-earphone-active"),
        response=_response(_product(copy="绝对是全网最值得买的耳机")),
        error_code=None,
        forbidden_words=["绝对"],
        latency_ms=10.0,
    )
    assert not verdict.passed
    assert verdict.veto is not None and "绝对" in verdict.veto


def test_banned_product_triggers_veto() -> None:
    """否决项：推荐了售罄商品，说明证据校验或 finalize 过滤失效。"""
    verdict = grade(
        _task("L3-out-of-stock-switch"),
        response=_response(_product("P015", category="数码")),
        error_code=None,
        forbidden_words=[],
        latency_ms=10.0,
    )
    assert not verdict.passed
    assert verdict.veto is not None and "P015" in verdict.veto


def test_wrong_category_fails_policy_dimension() -> None:
    verdict = grade(
        _task("L1-earphone-active"),
        response=_response(_product("P001", category="手机")),
        error_code=None,
        forbidden_words=[],
        latency_ms=10.0,
    )
    assert not verdict.passed
    assert verdict.scores["政策合规性"] is False
    assert verdict.scores["操作正确性"] is True  # 商品本身没问题，只是类目不对


def test_short_copy_fails_completeness_dimension() -> None:
    verdict = grade(
        _task("L1-earphone-active"),
        response=_response(_product(reason="好", copy="买")),
        error_code=None,
        forbidden_words=[],
        latency_ms=10.0,
    )
    assert not verdict.passed
    assert verdict.scores["信息完整性"] is False


def test_refusal_task_passes_only_on_expected_error_code() -> None:
    task = _task("L3-budget-impossible")
    good = grade(
        task,
        response=None,
        error_code="product_not_recalled",
        forbidden_words=[],
        latency_ms=5.0,
    )
    assert good.passed

    bad = grade(
        task,
        response=None,
        error_code="llm_not_configured",  # 环境问题，不是 Agent 正确拒绝
        forbidden_words=[],
        latency_ms=5.0,
    )
    assert not bad.passed


def test_refusal_task_fails_when_agent_answers_anyway() -> None:
    """本该拒绝却给了推荐——按幻觉否决处理，这是最严重的失败。"""
    verdict = grade(
        _task("L3-budget-impossible"),
        response=_response(_product()),
        error_code=None,
        forbidden_words=[],
        latency_ms=5.0,
    )
    assert not verdict.passed
    assert verdict.veto is not None


def test_summary_reports_pass_rate_by_level() -> None:
    verdicts = [
        grade(
            _task("L1-earphone-active"),
            response=_response(_product()),
            error_code=None,
            forbidden_words=[],
            latency_ms=10.0,
        ),
        grade(
            _task("L3-budget-impossible"),
            response=_response(_product()),
            error_code=None,
            forbidden_words=[],
            latency_ms=5.0,
        ),
    ]
    stats = summarize(EvalRun(model_id="test-model", verdicts=verdicts))
    assert stats.total == 2
    assert stats.passed == 1
    assert stats.pass_rate == 0.5
    assert stats.by_level["L1"].pass_rate == 1.0
    assert stats.by_level["L3"].pass_rate == 0.0
    assert stats.vetoes
    # JSON 输出要能序列化，供跨模型对比时消费
    assert '"pass_rate": 0.5' in stats.to_json()


def test_reliability_separates_stable_from_flaky() -> None:
    """Pass^k 和 Pass@k 必须能区分"稳定通过"和"时好时坏"。

    回归测试要看 Pass^k，用 Pass@k 会掩盖不稳定性。
    """
    stable = _task("L1-earphone-active")
    flaky = _task("L1-accessory-budget")

    def verdict(task, category: str, passed: bool):
        # 用最简单的方式造一个通过/不通过的判定。
        # category 要和任务要求的类目一致，否则会因为政策合规性而失败。
        if passed:
            return grade(
                task,
                response=_response(_product(category=category)),
                error_code=None,
                forbidden_words=[],
                latency_ms=1.0,
            )
        return grade(
            task,
            response=None,
            error_code="recommendation_failed",
            forbidden_words=[],
            latency_ms=1.0,
        )

    verdicts = [
        verdict(stable, "耳机", True),
        verdict(stable, "耳机", True),
        verdict(stable, "耳机", True),
        verdict(flaky, "配件", True),  # 同一条任务三次里只过了一次
        verdict(flaky, "配件", False),
        verdict(flaky, "配件", False),
    ]
    stats = summarize(EvalRun(model_id="test-model", verdicts=verdicts, repeat=3))

    assert stats.reliability.tasks == 2
    # 只有一条任务三次全过
    assert stats.reliability.always_passed == 1
    assert stats.reliability.pass_pow_k == 0.5
    # 但两条任务都"至少过一次"——这正是 Pass@k 会掩盖问题的地方
    assert stats.reliability.ever_passed == 2
    assert stats.reliability.pass_at_k == 1.0
    assert stats.reliability.flaky == [flaky.task_id]


@pytest.mark.asyncio
async def test_runner_resets_environment_between_tasks() -> None:
    """环境可重置性：两次跑同一条任务必须得到完全一致的结果。

    必须注入脚本化模型——否则会真的调用线上模型，既花钱又不确定，
    而不确定的评估器本身就是坏的评估器。
    """
    from evals.runner import run_task
    from tests.test_agent import ScriptedModel, successful_script

    task = _task("L1-earphone-active")
    first = await run_task(task, model=ScriptedModel(successful_script()))
    second = await run_task(task, model=ScriptedModel(successful_script()))

    assert first.passed == second.passed
    assert first.error_code == second.error_code
    assert first.scores == second.scores
    # 脚本里的文案含禁词"100%"，应当被 sanitize 替换掉，因此不触发否决项
    assert first.veto is None, f"意外触发否决项：{first.veto}"


def test_retrieval_evaluation_runs_without_a_model() -> None:
    """检索评估必须能脱离模型独立运行——这是它零成本的前提。

    同时校验标注集本身是有效的：如果标注的 doc_id 写错了，
    指标会莫名其妙地掉到 0，而不会有任何报错。
    """
    from evals.retrieval import RETRIEVAL_CASES, evaluate_retrieval, render_retrieval_report

    metrics = evaluate_retrieval()
    assert metrics.cases == len(RETRIEVAL_CASES)
    # 当前实现应当稳定在 80% 上下；跌破 50% 说明检索或分词出了问题
    assert metrics.recall_at_k >= 0.5, f"召回率异常偏低：{metrics.recall_at_k}"
    assert 0 <= metrics.mrr <= 1
    assert "recall@" in render_retrieval_report(metrics)


def test_every_retrieval_case_has_annotations() -> None:
    """没有标注的用例算不出任何指标，等于白跑。"""
    from evals.retrieval import RETRIEVAL_CASES

    for case in RETRIEVAL_CASES:
        assert case.relevant_docs, f"{case.case_id} 缺少相关文档标注"
        assert case.query.strip(), f"{case.case_id} 查询为空"


def test_error_codes_only_count_real_failures() -> None:
    """期望拒绝的任务成功拒绝时也带错误码，不该混进"错误分布"里。

    否则报告上会显示一堆错误码，但任务其实全通过了，
    看的人分不清"真正的问题有几个"。
    """
    refuse_task = _task("L3-budget-impossible")
    # 这是一次**正确的拒绝**：错误码在预期集合内，任务算通过
    correct_refusal = grade(
        refuse_task,
        response=None,
        error_code="product_not_recalled",
        forbidden_words=[],
        latency_ms=1.0,
    )
    assert correct_refusal.passed

    # 这是一次真正的失败
    real_failure = grade(
        _task("L1-earphone-active"),
        response=None,
        error_code="recommendation_failed",
        forbidden_words=[],
        latency_ms=1.0,
    )
    assert not real_failure.passed

    stats = summarize(EvalRun(model_id="test", verdicts=[correct_refusal, real_failure]))
    assert stats.error_codes == {"recommendation_failed": 1}
