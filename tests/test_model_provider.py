"""模型提供方与消融实验的测试。

消融实验（222 行）此前覆盖为 0，卡点只有一个：`build_model()` 自己 new 客户端、
自己读环境变量，调用方无处注入，没有真 key 就跑不起来。给这个 seam 一个名字之后
它就能离线跑了。

这里也钉住 model_id 的单一来源：报告里印的模型必须就是实际推理用的那个。
"""

from __future__ import annotations

import json

import pytest

from chatty.agent import Recommender
from chatty.catalog import Catalog
from chatty.model_provider import (
    EnvModelProvider,
    MissingCredentials,
    ModelProvider,
    StaticModelProvider,
    run_config,
    run_settings,
)
from evals.ablation import run_ablation
from evals.dataset import ALL_TASKS, Expect
from tests.test_agent import MessageStep, ScriptedModel


def test_thinking_is_disabled_through_reasoning_effort() -> None:
    """Responses API 上关 thinking 靠 reasoning.effort。

    chat/completions 那套 extra_body={"thinking": {"type": "disabled"}} 在 Responses
    上会被**静默忽略**——不报错，只是白花 reasoning token。所以这里钉住写法。
    """
    settings = run_settings()
    assert settings.reasoning is not None
    assert settings.reasoning.effort == "none"
    assert settings.extra_body is None


def test_tracing_stays_off() -> None:
    """用的是 DeepSeek 的 key，往 OpenAI 上报会刷一屏 401 噪音。"""
    assert run_config("Chatty test").tracing_disabled is True


def test_both_adapters_satisfy_the_interface() -> None:
    """两个 adapter 说明这是个真实的 seam，不是假想出来的。"""
    assert isinstance(EnvModelProvider(), ModelProvider)
    assert isinstance(StaticModelProvider(ScriptedModel([])), ModelProvider)


def test_missing_key_has_its_own_error_type(monkeypatch) -> None:
    """缺密钥是环境问题，不是 Agent 逻辑错误，所以要单独一个类型。"""
    from chatty import config

    monkeypatch.setattr(config, "load_root_env", lambda: None)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    provider = EnvModelProvider()
    # 只拿 model_id 不该联网，也不该因为没 key 就炸
    assert provider.model_id
    with pytest.raises(MissingCredentials):
        provider.model()


def test_model_id_has_one_source(catalog: Catalog) -> None:
    """报告里印的 model_id 必须就是实际推理用的模型。

    此前有三个独立来源（config.configured_model_id / build_model /
    Recommender._ensure_model），各读各的环境变量，没有代码保证它们一致。
    """
    provider = StaticModelProvider(ScriptedModel([]), model_id="pinned-model")
    assert Recommender(catalog, provider=provider).model_id == "pinned-model"


@pytest.mark.asyncio
async def test_ablation_counts_products_the_bare_model_made_up() -> None:
    """消融实验的判定标准全部客观可查，这里钉住「编造的 ID」那一条。"""
    task = next(t for t in ALL_TASKS if t.expect is Expect.SUCCEED)
    draft = json.dumps(
        {
            "recommendations": [
                # 目录里根本没有这个 ID —— 裸模型凭空编的
                {"product_id": "P999", "reason": "编的", "marketing_copy": "编的"},
                # 这个真实存在，用来确认统计没有一刀切
                {"product_id": "P003", "reason": "真的", "marketing_copy": "真的"},
            ]
        },
        ensure_ascii=False,
    )
    provider = StaticModelProvider(ScriptedModel([MessageStep("m-1", draft)]))

    result = await run_ablation((task,), provider=provider)

    assert result.tasks == 1
    assert result.responded == 1
    assert result.products == 2
    assert result.nonexistent == ["P999"]
    assert result.bad_product_rate == 0.5


@pytest.mark.asyncio
async def test_ablation_records_a_crashed_baseline_as_no_output() -> None:
    """裸模型崩了也是一种结果，不能让整批消融中断。"""
    task = next(t for t in ALL_TASKS if t.expect is Expect.SUCCEED)
    provider = StaticModelProvider(ScriptedModel([]))  # 脚本空的，跑起来就炸

    result = await run_ablation((task,), provider=provider)

    assert result.tasks == 1
    assert result.responded == 0
    assert result.products == 0
    assert result.bad_product_rate == 0.0
