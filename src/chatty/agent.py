from __future__ import annotations

import logging
import os
import re
import time
from uuid import uuid4

from agents import (
    Agent,
    AsyncOpenAI,
    Model,
    ModelSettings,
    OpenAIChatCompletionsModel,
    RunConfig,
    Runner,
)
from pydantic import ValidationError

from chatty import config
from chatty.catalog import Catalog, CatalogError
from chatty.debug import AgentDebugHooks
from chatty.experiments import ExperimentMetrics
from chatty.models import (
    RecommendationDraft,
    RecommendationRequest,
    RecommendationResponse,
)
from chatty.tools import TOOL_NAMES, RecommendationContext, build_tools

logger = logging.getLogger(__name__)

# Prompt 按“目标、执行、输出、约束”组织，让模型在每轮都能快速定位规则。
# Harness 仍会独立校验这些规则，不能把 prompt 当作业务事实的安全边界。
AGENT_INSTRUCTIONS = """你是 Chatty，一个电商推荐与营销 Agent。

目标
根据用户请求，推荐有库存且符合需求的商品。使用检索知识生成理由，并按用户分群生成营销文案。

执行
按以下顺序各调用一次：
1. get_user_profile：获取用户画像
2. search_products：搜索候选商品
3. check_inventory：检查候选商品库存
4. retrieve_knowledge：检索商品与营销知识
5. get_marketing_strategy：获取用户分群的营销策略

输出
只返回一个 JSON 对象：
{"recommendations":[{"product_id":"商品ID","reason":"推荐理由","marketing_copy":"营销文案"}]}

约束
- 只推荐 tool results 中经过搜索、库存检查和知识检索的商品。
- 理由和文案必须简洁，并基于检索知识与营销策略。
- 不得编造商品、价格、库存、促销或折扣。
- 不要调用未提供的 tool。"""

_JSON_CODE_BLOCK = re.compile(r"```(?:json)?\s*(\{.*\})\s*```", re.DOTALL | re.IGNORECASE)


def parse_recommendation_draft(raw_output: object) -> RecommendationDraft:
    if isinstance(raw_output, RecommendationDraft):
        return raw_output
    if not isinstance(raw_output, str):
        return RecommendationDraft.model_validate(raw_output)

    candidates = [raw_output]
    if match := _JSON_CODE_BLOCK.search(raw_output):
        candidates.insert(0, match.group(1))
    for candidate in candidates:
        try:
            return RecommendationDraft.model_validate_json(candidate)
        except ValidationError:
            continue
    return RecommendationDraft.model_validate_json(raw_output)


class RecommendationFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class RecommendationService:
    def __init__(
        self,
        catalog: Catalog,
        metrics: ExperimentMetrics,
        *,
        model: Model | None = None,
        model_id: str | None = None,
    ) -> None:
        self.catalog = catalog
        self.metrics = metrics
        self._model = model
        self._model_id = model_id or (
            "injected-model" if model is not None else config.configured_model_id()
        )
        self._client: AsyncOpenAI | None = None

    @property
    def model_id(self) -> str:
        return self._model_id

    def _ensure_model(self) -> Model:
        if self._model is not None:
            return self._model
        config.load_root_env()
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RecommendationFailure("llm_not_configured")
        base_url = os.environ.get("OPENAI_BASE_URL") or config.DEFAULT_BASE_URL
        self._model_id = os.environ.get("MODEL_ID") or config.DEFAULT_MODEL_ID
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        self._model = OpenAIChatCompletionsModel(
            model=self._model_id,
            openai_client=self._client,
        )
        return self._model

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()

        self.catalog.close()

    async def recommend(self, request: RecommendationRequest) -> RecommendationResponse:
        started = time.perf_counter()
        group = self.metrics.assign(request.user_id)
        debug_hooks = AgentDebugHooks(self._model_id) if config.agent_debug_enabled() else None
        try:
            model = self._ensure_model()
            context = RecommendationContext(
                request=request,
                catalog=self.catalog,
                experiment_group=group,
            )
            # DeepSeek V4 Pro rejects the SDK's json_schema response_format. Keep the
            # Chat Completions result textual, then extract and validate JSON locally.
            agent = Agent[RecommendationContext](
                name="Chatty",
                instructions=AGENT_INSTRUCTIONS,
                model=model,
                model_settings=ModelSettings(extra_body={"thinking": {"type": "disabled"}}),
                tools=build_tools(),
            )
            # Runner 执行 agent loop，并把每次 tool result 追加到下一轮模型输入。
            # max_turns 是失控保护，不是正常流程的重试策略。
            result = await Runner.run(
                agent,
                request.model_dump_json(),
                context=context,
                max_turns=10,
                hooks=debug_hooks,
                run_config=RunConfig(
                    workflow_name="Chatty recommendation",
                    tracing_disabled=True,
                ),
            )
            # Model 决定如何调用 Tool；Harness 用可观察状态验证它是否真的完成了流程。
            if context.used_tools != list(TOOL_NAMES):
                raise RecommendationFailure("required_tools_not_used")
            if not context.knowledge:
                raise RecommendationFailure("knowledge_not_retrieved")
            draft = parse_recommendation_draft(result.final_output)
            if context.profile is None:
                raise RecommendationFailure("profile_not_loaded")
            # 模型草稿只有文本建议权，商品范围必须由 Tool 留下的证据集合证明。
            recommended_ids = {item.product_id for item in draft.recommendations}
            if not recommended_ids <= context.recalled_product_ids:
                raise RecommendationFailure("product_not_recalled")
            if not recommended_ids <= context.in_stock_product_ids:
                raise RecommendationFailure("inventory_not_checked")
            if not recommended_ids <= context.knowledge_product_ids:
                raise RecommendationFailure("product_not_grounded")
            products = self.catalog.finalize(
                draft,
                request,
                context.profile,
                group,
            )
            elapsed_ms = (time.perf_counter() - started) * 1000
            response = RecommendationResponse(
                request_id=f"request_{uuid4().hex}",
                user_id=request.user_id,
                experiment_group=group,
                products=products,
                total_latency_ms=elapsed_ms,
            )
            self.metrics.record_request(group, success=True, latency_ms=elapsed_ms)
            if debug_hooks is not None:
                debug_hooks.record_response(response)
            return response
        except RecommendationFailure as error:
            elapsed_ms = (time.perf_counter() - started) * 1000
            self.metrics.record_request(group, success=False, latency_ms=elapsed_ms)
            if debug_hooks is not None:
                debug_hooks.record_failure(error.code)
            logger.warning("Recommendation failed with code=%s", error.code)
            raise
        except (CatalogError, ValidationError) as error:
            elapsed_ms = (time.perf_counter() - started) * 1000
            self.metrics.record_request(group, success=False, latency_ms=elapsed_ms)
            if debug_hooks is not None:
                debug_hooks.record_failure("invalid_recommendation")
            logger.warning("Invalid recommendation output", exc_info=True)
            raise RecommendationFailure("invalid_recommendation") from error
        except Exception as error:
            elapsed_ms = (time.perf_counter() - started) * 1000
            self.metrics.record_request(group, success=False, latency_ms=elapsed_ms)
            if debug_hooks is not None:
                debug_hooks.record_failure("recommendation_failed")
            logger.exception("Unexpected recommendation failure")
            raise RecommendationFailure("recommendation_failed") from error
