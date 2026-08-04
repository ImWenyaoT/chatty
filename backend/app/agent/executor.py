from __future__ import annotations

from typing import Any, cast

from agents import (
    Agent,
    ItemHelpers,
    ModelSettings,
    RunConfig,
    RunErrorHandlerInput,
    RunErrorHandlerResult,
    RunErrorHandlers,
    Runner,
    TResponseInputItem,
)
from agents.run_config import ToolExecutionConfig
from agents.tool import Tool

from app.agent.evidence import (
    EvidenceError,
    RecommendationEvidence,
    guard_repeated_call,
    record_inventory,
    record_run_usage,
    record_search,
    snapshot_evidence,
    validate_clarification_evidence,
    validate_recommendation_evidence,
)
from app.agent.framing import product_context
from app.agent.tools import CHATTY_TOOLS, ChattyRunContext
from app.agent.workflow import ChattyRunHooks, append_agent_status
from app.data.catalog import Catalog, CatalogError
from app.data.models import (
    AgentDraft,
    ClarifyReply,
    KnowledgeReply,
    RecommendationContext,
    RecommendationRequest,
    RecommendationResponse,
    Reply,
    TaskContext,
    TaskFrame,
)
from app.model_provider import ResponsesModelProvider

INSTRUCTIONS = """你是 Chatty，一个电商推荐与知识问答 Single Agent。

Harness 已按 TaskFrame 的非空字段准备 TaskContext，但不会提前检索知识。
knowledge_query 非空时，调用 retrieve_knowledge(scope="general")；观察结果后，
信息不足可以改写 query 再检索，最多检索三次，没有依据时明确说明没有查到。
recommendation 非空时，必须调用 retrieve_knowledge(scope="product") 与
get_marketing_strategy。混合请求需要分别检索 general 与 product。
不能在中途输出进度。

只推荐经过搜索、库存检查和知识检索支撑的商品。
价格与库存只采用 RecommendationContext，不得编造商品、优惠或折扣。
完成当前请求所需的 Tool，且知识充分后停止调用 Tool。
商品推荐输出：
{"action":"recommend","answer":"知识问题答案或 null",
"recommendations":[{"product_id":"商品ID","reason":"推荐理由",
"marketing_copy":"营销文案"}]}
只有知识问答时输出：{"action":"answer","answer":"有依据的答案"}
如果 candidates 为空，澄清时只能说当前条件下没有匹配商品，不能说缺货。
如果 candidates 非空但 inventory 为空，才可以说候选商品无库存。
两种情况都要先完成知识检索与营销策略；不要反复尝试同一预算。
需要澄清商品条件时才输出：
{"action":"clarify","question":"问题","answer":"知识问题答案或 null"}

每轮末尾的 <agent_status> 由 Harness 根据真实执行状态生成。
只调用 allowed_next 列出的 Tool；blocked 表示调用未执行，应按 required_next 纠正。
"""


def prepare_recommendation_context(
    request: RecommendationRequest,
    catalog: Catalog,
    evidence: RecommendationEvidence,
) -> RecommendationContext:
    """由 Harness 一次完成不需要 Model 判断的画像、搜索和库存步骤。"""

    profile = catalog.user_profile(request.user_id, request.context)
    evidence.profile = profile
    evidence.used_tools.append("get_user_profile")

    signature = request.model_dump_json()
    guard_repeated_call(evidence, "search_products", signature)
    candidates = catalog.search(
        profile=profile,
        categories=profile.preferred_categories,
        min_price_cents=profile.min_price_cents,
        max_price_cents=profile.max_price_cents,
        limit=10,
    )
    record_search(evidence, [product.product_id for product in candidates])

    inventory = catalog.inventory(evidence.recalled_product_order)
    record_inventory(evidence, [product.product_id for product in inventory])
    return RecommendationContext(
        request=request,
        profile=profile,
        candidates=candidates,
        inventory=inventory,
    )


def prepare_task_context(
    frame: TaskFrame,
    user_id: str,
    catalog: Catalog,
    evidence: RecommendationEvidence,
) -> TaskContext:
    """按 TaskFrame 的非空字段确定性准备 Context。"""

    recommendation: RecommendationContext | None = None
    if frame.product_need is not None:
        request = RecommendationRequest(
            user_id=user_id,
            num_items=3,
            context=product_context(frame.product_need),
        )
        recommendation = prepare_recommendation_context(request, catalog, evidence)

    if recommendation is None:
        evidence.required_support_tools = ("retrieve_knowledge",)

    scopes: list[str] = []
    if frame.knowledge_query is not None:
        scopes.append("general")
    if frame.product_need is not None:
        scopes.append("product")
    evidence.required_knowledge_scopes = tuple(scopes)

    return TaskContext(
        frame=frame,
        recommendation=recommendation,
    )


class RecommendationError(Exception):
    def __init__(self, code: str, diagnostics: dict[str, Any] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.diagnostics = diagnostics or {}


def build_chatty_agent(
    provider: ResponsesModelProvider,
) -> Agent[ChattyRunContext]:
    """使用 Agents SDK 声明 Chatty 的 Model、Tool 与结构化输出契约。"""

    model_settings = ModelSettings(tool_choice="required", reasoning={"effort": "none"})
    return Agent[ChattyRunContext](
        name="Chatty",
        instructions=INSTRUCTIONS,
        model=provider.agent_model,
        tools=cast(list[Tool], CHATTY_TOOLS),
        output_type=AgentDraft,
        model_settings=model_settings,
        reset_tool_choice=True,
    )


def build_draft_correction_agent(
    provider: ResponsesModelProvider,
) -> Agent[None]:
    """把 provider 未遵守 Schema 的最终文本纠正为同一个结构化契约。"""

    return Agent[None](
        name="Chatty Draft Corrector",
        instructions=(
            "把输入改写为指定的结构化输出。只保留输入已有事实，不增加商品、优惠或折扣。"
        ),
        model=provider.agent_model,
        output_type=AgentDraft,
        model_settings=ModelSettings(reasoning={"effort": "none"}),
    )


async def correct_invalid_draft(
    data: RunErrorHandlerInput[ChattyRunContext],
    provider: ResponsesModelProvider,
) -> RunErrorHandlerResult:
    raw = "".join(
        ItemHelpers.extract_text(item) or ""
        for response in data.run_data.raw_responses
        for item in response.output
    )
    corrected = await Runner.run(
        build_draft_correction_agent(provider),
        raw,
        max_turns=1,
    )
    data.context.usage.add(corrected.context_wrapper.usage)
    return RunErrorHandlerResult(final_output=corrected.final_output)


class ChattyExecutor:
    def __init__(
        self,
        catalog: Catalog,
        provider: ResponsesModelProvider,
    ) -> None:
        self.catalog = catalog
        self.provider = provider

    async def respond(
        self,
        task_context: TaskContext,
        evidence: RecommendationEvidence,
        user_text: str,
        history: list[dict[str, Any]] | None = None,
    ) -> Reply:
        recommendation_context = task_context.recommendation
        request = (
            recommendation_context.request
            if recommendation_context is not None
            else None
        )
        # RunContext 同时带业务依赖和 Harness Evidence。Tool 可以写 Evidence，
        # 但这部分不会作为 Tool Result 回传给模型。
        run_context = ChattyRunContext(
            request=request,
            catalog=self.catalog,
            evidence=evidence,
        )
        agent = build_chatty_agent(self.provider)
        model_input = cast(list[TResponseInputItem], list(history or []))
        # 原始用户输入和 Harness-owned Context 分开标源；query rewrite 不能替代原话。
        model_input.append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": user_text,
                    }
                ],
            }
        )
        model_input.append(
            {
                "role": "developer",
                "content": [
                    {
                        "type": "input_text",
                        "text": (
                            "<harness_context>\n"
                            f"{task_context.model_dump_json()}\n"
                            "</harness_context>"
                        ),
                    }
                ],
            }
        )

        try:
            error_handlers: RunErrorHandlers[ChattyRunContext] = {
                "invalid_final_output": lambda data: correct_invalid_draft(
                    data, self.provider
                )
            }
            result = await Runner.run(
                agent,
                model_input,
                context=run_context,
                max_turns=12,
                hooks=ChattyRunHooks(),
                run_config=RunConfig(
                    call_model_input_filter=append_agent_status,
                    tool_execution=ToolExecutionConfig(max_function_tool_concurrency=1),
                ),
                error_handlers=error_handlers,
            )
            record_run_usage(evidence, result.context_wrapper.usage)
            draft = result.final_output

            _validate_knowledge_answer(task_context, evidence, draft.answer)

            if draft.action == "answer":
                if (
                    task_context.frame.knowledge_query is None
                    or recommendation_context is not None
                    or draft.answer is None
                ):
                    raise RecommendationError("invalid_draft")
                return KnowledgeReply(answer=draft.answer)

            if draft.action == "clarify":
                if recommendation_context is None:
                    raise RecommendationError("invalid_draft")
                validate_clarification_evidence(evidence)
                if draft.question is None:
                    raise RecommendationError("invalid_draft")
                return ClarifyReply(
                    question=draft.question,
                    answer=draft.answer,
                )

            recommendations = draft.recommendations
            if recommendations is None:
                raise RecommendationError("invalid_draft")
            if recommendation_context is None or request is None:
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
                answer=draft.answer,
            )
        except RecommendationError as error:
            diagnostics = _diagnostics(evidence, error)
            diagnostics.update(error.diagnostics)
            raise RecommendationError(error.code, diagnostics) from error
        except EvidenceError as error:
            diagnostics = _diagnostics(evidence, error)
            diagnostics["missing"] = error.missing
            diagnostics["detail"] = error.detail
            raise RecommendationError(error.code, diagnostics) from error
        except CatalogError as error:
            raise RecommendationError(
                str(error), _diagnostics(evidence, error)
            ) from error
        except Exception as error:
            # Tool 或 SDK 的未知异常不能穿透 HTTP 层成为无结构的 500。
            raise RecommendationError(
                "recommendation_failed", _diagnostics(evidence, error)
            ) from error


def _validate_knowledge_answer(
    task_context: TaskContext,
    evidence: RecommendationEvidence,
    answer: str | None,
) -> None:
    if task_context.frame.knowledge_query is None:
        return
    if not answer:
        raise RecommendationError("invalid_draft")
    if evidence.general_knowledge_hits == 0:
        raise RecommendationError("knowledge_not_retrieved")


def _diagnostics(evidence: RecommendationEvidence, error: Exception) -> dict[str, Any]:
    return {
        "evidence": snapshot_evidence(evidence).model_dump(),
        "cause": str(error),
    }
