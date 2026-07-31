"""模型提供方：拿到一个能跑的模型，和调它时该带上的设置。

`build_model()` 此前自己 new 客户端、自己读环境变量，调用方无处注入。后果是
消融实验（222 行）、demo 的交互模式和多轮评估的用户模拟器全部只能连真实 API 才
能跑，因此一个测试都没有——而恰恰是没被测的那条路径出过 bug。

替身其实一直存在两个（tests 里的 ScriptedModel 和一个假 chat client），只是没有
名字，也只能从 `Recommender(model=...)` 那一个入口进去。两个 adapter 说明这是个
真实的 seam，那就给它一个 interface。

seam 后面有两样东西，因为 chatty 用模型的方式有两种：

  · model()    —— 走 Agent Loop 的那次推荐，交给 Agents SDK
  · complete() —— demo 解析大白话、评估的用户模拟器答话。这两处不需要工具，
                  一问一答就够，走 Agent Loop 反而更慢更不稳

`complete` 刻意不暴露裸 chat 客户端。调用方要的从来只是「给一段话，拿一段文本」，
把 `client.chat.completions.create(...)` 这层形状漏出去，替身就得跟着长出
`self.chat = self; self.completions = self` 这种东西——测试里原本就是这么写的。

`run_settings()` 和 `run_config()` 不在 interface 里——它们不随 adapter 变化，
是所有调用方共享的实现。放在这里是为了让消融对照组和生产用**同一份**设置：
早先 ablation.py 各抄了一份，生产改了配置对照组不跟着变，比的就不再是「有没有
Harness」了。
"""

from __future__ import annotations

import os
from typing import Protocol, runtime_checkable

from agents import (
    AsyncOpenAI,
    Model,
    ModelSettings,
    OpenAIResponsesModel,
    RunConfig,
)
from openai.types.shared import Reasoning
from openai.types.shared_params import Reasoning as ReasoningParam

from chatty import config

# DeepSeek 2026-07-31 起支持 Responses API（目前只覆盖 v4-flash，v4-pro 要等 8 月初）。
#
# 关 thinking 的写法跟着变了：chat/completions 走 extra_body {"thinking": {"type":
# "disabled"}}，Responses 走 reasoning.effort。实测 extra_body 那套在 Responses 上会被
# **静默忽略**——照搬过来不会报错，只会白花 reasoning token，所以这里必须换。
# 两份是因为 SDK 两侧的类型不同：ModelSettings 收 pydantic 模型，
# responses.create 收 TypedDict。值是同一个。
_NO_THINKING = Reasoning(effort="none")
_NO_THINKING_PARAM: ReasoningParam = {"effort": "none"}


@runtime_checkable
class ModelProvider(Protocol):
    """一个能提供模型的东西。生产连真实 API，测试给替身。"""

    @property
    def model_id(self) -> str:
        """报告里印的就是这个，必须和实际推理用的模型一致。"""
        ...

    def model(self) -> Model:
        """给 Agents SDK 用的模型。"""
        ...

    async def complete(self, prompt: str, *, system: str | None = None) -> str:
        """一问一答：给一段话，拿一段文本。不走 Agent Loop，也没有工具。"""
        ...

    async def close(self) -> None: ...


def run_settings() -> ModelSettings:
    """调模型时的设置。effort="none" 是 Responses API 上关 thinking 的开关。"""
    return ModelSettings(reasoning=_NO_THINKING)


def run_config(workflow_name: str) -> RunConfig:
    """Agents SDK 的运行配置。

    tracing 一律关掉：用的是 DeepSeek 的 key，往 OpenAI 上报会刷一屏 401 噪音。
    """
    return RunConfig(workflow_name=workflow_name, tracing_disabled=True)


class MissingCredentials(RuntimeError):
    """没配密钥。属于环境问题，不是 Agent 逻辑错误，所以要单独一个类型。"""


class EnvModelProvider:
    """按环境变量连真实模型。

    连接是惰性建的：只拿 model_id 不真跑的场合（比如打印一行「当前模型」）
    不该顺手开一个 HTTP 连接。
    """

    def __init__(self) -> None:
        config.load_root_env()
        self._model_id = os.environ.get("MODEL_ID") or config.DEFAULT_MODEL_ID
        self._client: AsyncOpenAI | None = None

    @property
    def model_id(self) -> str:
        return self._model_id

    def _ensure_client(self) -> AsyncOpenAI:
        if self._client is None:
            api_key = os.environ.get("OPENAI_API_KEY")
            if not api_key:
                raise MissingCredentials("llm_not_configured")
            base_url = os.environ.get("OPENAI_BASE_URL") or config.DEFAULT_BASE_URL
            self._client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        return self._client

    def model(self) -> Model:
        return OpenAIResponsesModel(
            model=self._model_id,
            openai_client=self._ensure_client(),
        )

    async def complete(self, prompt: str, *, system: str | None = None) -> str:
        response = await self._ensure_client().responses.create(
            model=self._model_id,
            instructions=system,
            input=prompt,
            reasoning=_NO_THINKING_PARAM,
        )
        return response.output_text or ""

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None


class StaticModelProvider:
    """拿一个现成的模型当提供方。测试的替身走这条。

    `replies` 是 complete() 依次返回的答案；用完就一直返回最后一条。留空表示
    「这个提供方不该被问」——真被问到就报错，而不是悄悄连上真实 API。
    """

    def __init__(
        self,
        model: Model,
        *,
        model_id: str = "injected-model",
        replies: list[str] | None = None,
    ) -> None:
        self._model = model
        self._model_id = model_id
        self._replies = list(replies or [])
        self.prompts: list[str] = []  # 问过什么，测试拿来断言

    @property
    def model_id(self) -> str:
        return self._model_id

    def model(self) -> Model:
        return self._model

    async def complete(self, prompt: str, *, system: str | None = None) -> str:
        self.prompts.append(prompt)
        if not self._replies:
            raise RuntimeError("这个提供方没有准备答案，注入 replies 再用")
        return self._replies.pop(0) if len(self._replies) > 1 else self._replies[0]

    async def close(self) -> None:
        """注入进来的东西不由这里关——所有权归建它的人。"""
