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
from chatty.experiments import ExperimentMetrics
from chatty.models import (
    RecommendationDraft,
    RecommendationRequest,
    RecommendationResponse,
)
from chatty.tools import TOOL_NAMES, RecommendationContext, build_tools

logger = logging.getLogger(__name__)

AGENT_INSTRUCTIONS = """你是 Chatty，一个电商推荐与营销 Agent。
你必须依次完成五件事：
1. 调用 get_user_profile 获取用户画像；
2. 调用 search_products 搜索候选商品；
3. 调用 check_inventory，缺货商品不得推荐；
4. 调用 retrieve_knowledge 检索商品指南与营销知识，用检索证据支持理由和文案；
5. 调用 get_marketing_strategy 获取当前用户分群的营销风格。
最终只输出一个 JSON 对象，格式为
{"recommendations":[{"product_id":"商品ID","reason":"推荐理由","marketing_copy":"营销文案"}]}。
每个商品必须来自工具结果，并提供简洁的推荐理由和营销文案。
不得编造商品、价格、库存、促销或折扣。不要调用不存在的工具。"""

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
            result = await Runner.run(
                agent,
                request.model_dump_json(),
                context=context,
                max_turns=10,
                run_config=RunConfig(
                    workflow_name="Chatty recommendation",
                    tracing_disabled=True,
                ),
            )
            if set(TOOL_NAMES) != context.used_tools:
                raise RecommendationFailure("required_tools_not_used")
            if not context.knowledge:
                raise RecommendationFailure("knowledge_not_retrieved")
            draft = parse_recommendation_draft(result.final_output)
            if context.profile is None:
                raise RecommendationFailure("profile_not_loaded")
            products = self.catalog.finalize(
                draft,
                request,
                context.profile,
                group,
            )
            elapsed_ms = (time.perf_counter() - started) * 1000
            self.metrics.record_request(group, success=True, latency_ms=elapsed_ms)
            return RecommendationResponse(
                request_id=f"request_{uuid4().hex}",
                user_id=request.user_id,
                experiment_group=group,
                products=products,
                total_latency_ms=elapsed_ms,
            )
        except RecommendationFailure as error:
            elapsed_ms = (time.perf_counter() - started) * 1000
            self.metrics.record_request(group, success=False, latency_ms=elapsed_ms)
            logger.warning("Recommendation failed with code=%s", error.code)
            raise
        except (CatalogError, ValidationError) as error:
            elapsed_ms = (time.perf_counter() - started) * 1000
            self.metrics.record_request(group, success=False, latency_ms=elapsed_ms)
            logger.warning("Invalid recommendation output", exc_info=True)
            raise RecommendationFailure("invalid_recommendation") from error
        except Exception as error:
            elapsed_ms = (time.perf_counter() - started) * 1000
            self.metrics.record_request(group, success=False, latency_ms=elapsed_ms)
            logger.exception("Unexpected recommendation failure")
            raise RecommendationFailure("recommendation_failed") from error
