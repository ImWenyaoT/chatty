from __future__ import annotations

import re
import time
from typing import Any, cast

from agents import Agent, ModelSettings, Runner, TResponseInputItem
from agents.tool import Tool
from pydantic import ValidationError

from app.catalog import Catalog, CatalogError
from app.evidence import (
    EvidenceError,
    RecommendationEvidence,
    snapshot_evidence,
    validate_clarification_evidence,
    validate_recommendation_evidence,
)
from app.model_provider import MissingCredentialsError, ResponsesModelProvider
from app.models import (
    AgentDraft,
    ClarifyReply,
    RecommendationRequest,
    RecommendationResponse,
    Reply,
)
from app.tools import CHATTY_TOOLS, ChattyRunContext

INSTRUCTIONS = """你是 Chatty，一个电商推荐与营销 Single Agent。

必须完成以下五步，不能只解释下一步，也不能在中途输出进度：
1. get_user_profile
2. search_products
3. check_inventory
4/5. retrieve_knowledge 与 get_marketing_strategy（两者可换序）

只推荐经过搜索、库存检查和知识检索支撑的商品。
价格与库存只采用 Tool Result，不得编造商品、优惠或折扣。
五个 Tool 全部完成后停止调用 Tool，只输出下面形状的 JSON，不要 Markdown，不要说明文字：
{"action":"recommend","recommendations":[{"product_id":"商品ID","reason":"推荐理由","marketing_copy":"营销文案"}]}
如果 search_products 返回空数组，立即用空数组调用 check_inventory，
再完成知识检索与营销策略，最后输出澄清 JSON；不要反复尝试同一预算。
需要澄清时才输出：{"action":"clarify","question":"问题"}
"""


class RecommendationError(Exception):
    def __init__(self, code: str, diagnostics: dict[str, Any] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.diagnostics = diagnostics or {}


def parse_draft(raw: str) -> AgentDraft:
    """从模型文本中找到 JSON，并交给 Pydantic 做最终结构校验。"""

    fenced = re.search(r"```(?:json)?\s*(\{[\s\S]*\})\s*```", raw, re.I)
    start = raw.find("{")
    end = raw.rfind("}")

    fenced_json: str | None = None
    if fenced is not None:
        fenced_json = fenced.group(1)

    embedded_json: str | None = None
    if start >= 0 and end > start:
        embedded_json = raw[start : end + 1]

    # 模型通常直接返回 JSON；另外两个候选只处理常见的 Markdown 包裹。
    candidates = [fenced_json, embedded_json, raw]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            return AgentDraft.model_validate_json(candidate)
        except ValidationError:
            continue
    raise RecommendationError("invalid_draft")


class Recommender:
    def __init__(
        self,
        catalog: Catalog,
        provider: ResponsesModelProvider,
    ) -> None:
        self.catalog = catalog
        self.provider = provider

    async def respond(
        self,
        request: RecommendationRequest,
        history: list[dict[str, Any]] | None = None,
    ) -> Reply:
        started = time.perf_counter()
        if not self.provider.configured:
            raise RecommendationError("llm_not_configured")

        evidence = RecommendationEvidence()
        # RunContext 同时带业务依赖和 Harness Evidence。Tool 可以写 Evidence，
        # 但这部分不会作为 Tool Result 回传给模型。
        run_context = ChattyRunContext(
            request=request,
            catalog=self.catalog,
            evidence=evidence,
        )
        agent = Agent[ChattyRunContext](
            name="Chatty",
            instructions=INSTRUCTIONS,
            model=self.provider.agent_model,
            tools=cast(list[Tool], CHATTY_TOOLS),
            model_settings=ModelSettings(
                tool_choice="required",
                parallel_tool_calls=False,
                reasoning={"effort": "none"},
            ),
            reset_tool_choice=True,
        )
        model_input = cast(list[TResponseInputItem], list(history or []))
        # SDK 接收结构化历史，避免第二轮把纯字符串误当成消息对象。
        model_input.append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": request.model_dump_json(),
                    }
                ],
            }
        )

        try:
            result = await Runner.run(
                agent,
                model_input,
                context=run_context,
                max_turns=18,
            )
            draft = parse_draft(str(result.final_output))
            latency_ms = (time.perf_counter() - started) * 1000

            if draft.action == "clarify":
                validate_clarification_evidence(evidence)
                if draft.question is None:
                    raise RecommendationError("invalid_draft")
                return ClarifyReply(
                    question=draft.question,
                    total_latency_ms=latency_ms,
                )

            recommendations = draft.recommendations
            if recommendations is None:
                raise RecommendationError("invalid_draft")

            # 模型输出现在仍是草稿。只有 Evidence 校验与 SQLite 重查都通过，
            # 才能构造给用户看的 RecommendationResponse。
            validate_recommendation_evidence(evidence, recommendations)
            if evidence.profile is None:
                raise RecommendationError("profile_not_loaded")
            products = self.catalog.finalize(
                recommendations,
                request,
                evidence.profile,
            )
            self.catalog.update_user_profile_after_success(
                request.user_id,
                request.context.preferred_categories or [],
            )
            return RecommendationResponse(
                products=products,
                total_latency_ms=latency_ms,
            )
        except RecommendationError as error:
            diagnostics = _diagnostics(evidence, error)
            diagnostics.update(error.diagnostics)
            raise RecommendationError(error.code, diagnostics) from error
        except MissingCredentialsError as error:
            raise RecommendationError(
                "llm_not_configured", _diagnostics(evidence, error)
            ) from error
        except EvidenceError as error:
            diagnostics = _diagnostics(evidence, error)
            diagnostics["missing"] = error.missing
            diagnostics["detail"] = error.detail
            raise RecommendationError(error.code, diagnostics) from error
        except CatalogError as error:
            raise RecommendationError(
                str(error), _diagnostics(evidence, error)
            ) from error


def _diagnostics(evidence: RecommendationEvidence, error: Exception) -> dict[str, Any]:
    return {
        "evidence": snapshot_evidence(evidence).model_dump(),
        "cause": str(error),
    }
