"""多轮评估的测试。

这条路径此前**一个测试都没有**：`run_multiturn_suite` 里的 Recommender 没有模型
注入口，用户模拟器的 client 也是硬编码建的，所以没有真 API key 就跑不起来。
两个可选参数穿到底之后，用已有的 ScriptedModel 和一个假 chat client 就能离线跑完。

判分部分（grade_multiturn）是纯函数，直接喂造好的会话结果，不用跑模型。
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from chatty.models import ClarifyReply, RecommendationResponse, RecommendedProduct
from evals.multiturn import (
    MultiTurnEvidence,
    MultiTurnTask,
    TurnRecord,
    grade_multiturn,
    run_multiturn_suite,
)
from evals.session import SessionOutcome
from tests.test_agent import MessageStep, ScriptedModel, successful_script


class _FakeChatClient:
    """用户模拟器的替身：不管问什么都答同一句。"""

    def __init__(self, answer: str) -> None:
        self.answer = answer
        self.questions: list[str] = []
        self.chat = self
        self.completions = self

    async def create(self, **kwargs: Any) -> Any:
        self.questions.append(kwargs["messages"][0]["content"])
        message = type("_M", (), {"content": self.answer})()
        return type("_C", (), {"choices": [type("_X", (), {"message": message})()]})()

    async def close(self) -> None:  # pragma: no cover - 注入进来的不该被关
        raise AssertionError("注入的 client 不该被 suite 关掉")


def _product(**overrides: Any) -> RecommendedProduct:
    fields: dict[str, Any] = {
        "product_id": "P003",
        "name": "降噪耳机",
        "category": "耳机",
        "price_cents": 189900,
        "brand": "示例",
        "stock": 50,
        "tags": ["降噪"],
        "score": 0.8,
        "low_stock": True,
        "reason": "适合通勤",
        "marketing_copy": "安静下来",
    }
    fields.update(overrides)
    return RecommendedProduct(**fields)


def _response(*products: RecommendedProduct) -> RecommendationResponse:
    return RecommendationResponse(
        request_id="request_test",
        user_id="user_active",
        products=list(products),
        total_latency_ms=1.0,
    )


def _task(**overrides: Any) -> MultiTurnTask:
    fields: dict[str, Any] = {
        "task_id": "T",
        "intent": "测试用",
        "user_id": "user_active",
        "opening": "想找个听歌用的",
        "facts": {"类目": "耳机"},
        "expect_category": "耳机",
    }
    fields.update(overrides)
    return MultiTurnTask(**fields)


# ============================================================================
# 判分（纯函数）
# ============================================================================


def test_a_clean_recommendation_passes() -> None:
    verdict = grade_multiturn(
        _task(),
        SessionOutcome(reply=_response(_product())),
        MultiTurnEvidence(turns=1),
    )
    assert verdict.passed
    assert verdict.reasons == []


def test_wrong_category_fails() -> None:
    verdict = grade_multiturn(
        _task(expect_category="家电"),
        SessionOutcome(reply=_response(_product())),
        MultiTurnEvidence(turns=1),
    )
    assert not verdict.passed
    assert "类目是 耳机" in verdict.reasons[0]


def test_price_ceiling_is_actually_enforced() -> None:
    """价格上限这条校验此前从未执行过：三条任务的 max_price_cents 全是 None。"""
    verdict = grade_multiturn(
        _task(max_price_cents=100_000),
        SessionOutcome(reply=_response(_product(price_cents=189_900))),
        MultiTurnEvidence(turns=1),
    )
    assert not verdict.passed
    assert any("超出上限" in reason for reason in verdict.reasons)


def test_asking_about_categories_means_listing_them() -> None:
    """must_ask_about 的「类目」查的是问句里有没有真实类目名，不是「反问过没有」。

    这是改写前的真实缺陷：那条分支只判 clarify_count == 0，
    于是 Agent 反问「你预算多少」也能拿满分。
    """
    evidence = MultiTurnEvidence(
        transcript=[TurnRecord("Agent", "你预算多少？")],
        clarify_count=1,
        turns=2,
        categories=["家电", "耳机"],
    )
    verdict = grade_multiturn(
        _task(must_ask_about=frozenset({"类目"})),
        SessionOutcome(reply=_response(_product())),
        evidence,
    )
    assert not verdict.passed
    assert "没有把可选类目列给用户" in verdict.reasons[0]

    listed = MultiTurnEvidence(
        transcript=[TurnRecord("Agent", "你想看哪一类？我们有家电、耳机")],
        clarify_count=1,
        turns=2,
        categories=["家电", "耳机"],
    )
    assert grade_multiturn(
        _task(must_ask_about=frozenset({"类目"})),
        SessionOutcome(reply=_response(_product())),
        listed,
    ).passed


def test_clarifying_when_it_should_not_fails() -> None:
    verdict = grade_multiturn(
        _task(max_clarify=0),
        SessionOutcome(reply=_response(_product())),
        MultiTurnEvidence(clarify_count=1, turns=2),
    )
    assert not verdict.passed
    assert "澄清了 1 次" in verdict.reasons[0]


def test_a_crash_is_reported_as_its_error_code() -> None:
    """跑崩了也是一种结果，但要保留 error_code——此前统一收敛成一句话，维度丢了。"""
    verdict = grade_multiturn(
        _task(),
        SessionOutcome(error_code="eval_harness_error"),
        MultiTurnEvidence(turns=1),
    )
    assert not verdict.passed
    assert verdict.reasons == ["运行失败：eval_harness_error"]


def test_never_reaching_a_recommendation_fails() -> None:
    clarify = ClarifyReply(
        request_id="request_test",
        user_id="user_active",
        question="你想看哪一类？",
        total_latency_ms=1.0,
    )
    verdict = grade_multiturn(_task(), SessionOutcome(reply=clarify), MultiTurnEvidence(turns=4))
    assert not verdict.passed
    assert "没给出推荐" in verdict.reasons[0]


# ============================================================================
# 端到端（离线）
# ============================================================================


@pytest.mark.asyncio
async def test_multiturn_suite_runs_offline_with_injected_model_and_client() -> None:
    """开场问一句 → Agent 反问 → 模拟用户答 → 给出推荐，全程不联网。"""
    clarify = MessageStep(
        "clarify-1",
        json.dumps(
            {"action": "clarify", "question": "你想看哪一类商品？我们有：耳机、家电"},
            ensure_ascii=False,
        ),
    )
    model = ScriptedModel([clarify, *successful_script()])
    client = _FakeChatClient("耳机")

    verdicts = await run_multiturn_suite(
        (_task(task_id="M-offline", must_ask_about=frozenset({"类目"})),),
        model=model,
        client=client,
    )

    assert len(verdicts) == 1
    verdict = verdicts[0]
    assert verdict.passed, verdict.reasons
    assert verdict.clarify_count == 1
    assert verdict.turns == 2
    # 模拟器被问到了 Agent 那句反问
    assert "你想看哪一类商品" in client.questions[0]
    # 对话记录能还原整段过程：开场 → 反问 → 回答 → 推荐
    assert [record.speaker for record in verdict.transcript] == [
        "用户",
        "Agent",
        "用户",
        "Agent",
    ]
