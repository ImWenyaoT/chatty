"""运行主 Agent Loop，并用 Harness Evidence 校验模型草稿。

这个文件位于 `chatty.py` 和 Agents SDK 之间：

1. `prepare_task_context()` 从 SQLite 准备模型可以参考的业务 Context；
2. `_generate_draft()` 让 Model 调用 Tool，并返回 `AgentDraft`；
3. `_finalize_reply()` 不相信草稿中的事实，重新用 Evidence 和 SQLite 校验；
4. 校验成功后才返回 `Reply`，失败则统一抛出 `RecommendationError`。

Python 的类型提示不会像 TypeScript 那样在运行时自动拦截错误。本项目同时使用 ty 做静态
检查、使用 Pydantic Model 做运行时校验。看到 `AgentDraft`、`TaskContext` 这类类型时，
可以把它们理解为既给人看的数据结构说明，也是实际会执行校验的对象。
"""

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
    """由 Harness 一次完成不需要 Model 判断的画像、搜索和库存步骤。

    三个参数都是已经创建好的对象，函数会更新 evidence，并返回新的
    RecommendationContext。商品价格、库存等事实只从 catalog（SQLite）读取。
    """

    # profile 是根据 user_id、历史画像和本轮明确条件合并出的当前用户画像。
    profile = catalog.user_profile(request.user_id, request.context)

    # Evidence 是 Harness 自己的账本。记录 profile 后，Model 不能声称没执行过的步骤。
    evidence.profile = profile
    evidence.used_tools.append("get_user_profile")

    # signature 是本次搜索参数的稳定字符串，只用于识别完全相同的重复调用。
    signature = request.model_dump_json()
    guard_repeated_call(evidence, "search_products", signature)

    # candidates 包含符合画像和预算的候选商品，此时还没有确认库存。
    candidates = catalog.search(
        profile=profile,
        categories=profile.preferred_categories,
        min_price_cents=profile.min_price_cents,
        max_price_cents=profile.max_price_cents,
        limit=10,
    )
    record_search(evidence, [product.product_id for product in candidates])

    # inventory 只保留 candidates 中当前库存大于零的商品。
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
    """按 TaskFrame 的非空字段确定性准备 Context。

    TaskFrame 可能只有知识问题、只有商品需求，也可能两者都有。这里把这三种情况统一
    整理成 TaskContext，让后面的 Agent Loop 不需要再次猜测用户意图。
    """

    # `A | None` 等价于 TypeScript 的 `A | null`：变量可能没有推荐部分。
    recommendation: RecommendationContext | None = None
    if frame.product_need is not None:
        # ProductNeed 使用“元”，Catalog 使用“分”；product_context() 负责转换单位。
        request = RecommendationRequest(
            user_id=user_id,
            num_items=3,
            context=product_context(frame.product_need),
        )
        recommendation = prepare_recommendation_context(request, catalog, evidence)

    # 纯知识问答不需要营销策略，只需要知识检索。
    if recommendation is None:
        evidence.required_support_tools = ("retrieve_knowledge",)

    # scope 告诉 Evidence：本轮必须完成通用知识、商品知识，或者两者都完成。
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
    """Executor 对外的稳定失败类型，code 给 HTTP 层，diagnostics 给日志。"""

    def __init__(self, code: str, diagnostics: dict[str, Any] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.diagnostics = diagnostics or {}


def build_chatty_agent(
    provider: ResponsesModelProvider,
) -> Agent[ChattyRunContext]:
    """使用 Agents SDK 声明 Chatty 的 Model、Tool 与结构化输出契约。

    `Agent[ChattyRunContext]` 中的方括号是泛型：表示运行这个 Agent 时，context 应当是
    ChattyRunContext。它只帮助类型检查，不会创建另一个 Agent。
    """

    # tool_choice="required" 强制第一轮先调用 Tool，不能跳过事实准备直接生成答案。
    model_settings = ModelSettings(tool_choice="required", reasoning={"effort": "none"})
    return Agent[ChattyRunContext](
        name="Chatty",
        instructions=INSTRUCTIONS,
        model=provider.agent_model,
        # SDK 装饰器生成的 Tool 类型很具体；cast 只告诉 ty 它满足通用 Tool 列表。
        # cast 不转换运行时对象，也不会吞掉错误。
        tools=cast(list[Tool], CHATTY_TOOLS),
        # Agents SDK 会把最终输出交给 Pydantic，运行时验证是否符合 AgentDraft。
        output_type=AgentDraft,
        model_settings=model_settings,
        reset_tool_choice=True,
    )


def build_draft_correction_agent(
    provider: ResponsesModelProvider,
) -> Agent[None]:
    """把 provider 未遵守 Schema 的最终文本纠正为同一个结构化契约。

    这个 Agent 没有 Tool，只负责修正 JSON 形状；它不能搜索商品或补充新事实。
    """

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
    """读取失败响应中的文本，执行一次受限纠正，并把 Usage 计入主流程。"""

    # raw_responses 是 SDK 保存的原始 Model 响应。这里把其中所有文本片段拼起来。
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

    # 纠正过程也调用了 Model，不能在统计里悄悄漏掉这次费用。
    data.context.usage.add(corrected.context_wrapper.usage)
    return RunErrorHandlerResult(final_output=corrected.final_output)


class ChattyExecutor:
    """主 Agent Loop 的执行器；公开方法只有 `respond()`。"""

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
        """先生成 Model 草稿，再用确定性代码把草稿收敛为 Reply。"""

        try:
            # draft 仍然只是 Model 的提议，不能直接返回给用户。
            draft = await self._generate_draft(
                task_context,
                evidence,
                user_text,
                history,
            )
            # finalize 是信任边界：只有通过 Evidence 和 SQLite 校验才能成为 Reply。
            return self._finalize_reply(task_context, evidence, draft)

        # 下面四个 except 把不同来源的失败统一成 RecommendationError。
        # `raise ... from error` 会保留原异常链，日志仍能看到真正原因。
        except RecommendationError as error:
            diagnostics = _diagnostics(evidence, error)
            diagnostics.update(error.diagnostics)
            raise RecommendationError(error.code, diagnostics) from error
        except EvidenceError as error:
            # missing/detail 是 Evidence 校验特有的定位信息。
            diagnostics = _diagnostics(evidence, error)
            diagnostics["missing"] = error.missing
            diagnostics["detail"] = error.detail
            raise RecommendationError(error.code, diagnostics) from error
        except CatalogError as error:
            # CatalogError 的消息本身就是稳定业务错误码。
            raise RecommendationError(
                str(error), _diagnostics(evidence, error)
            ) from error
        except Exception as error:
            # Tool 或 SDK 的未知异常不能穿透 HTTP 层成为无结构的 500。
            raise RecommendationError(
                "recommendation_failed", _diagnostics(evidence, error)
            ) from error

    async def _generate_draft(
        self,
        task_context: TaskContext,
        evidence: RecommendationEvidence,
        user_text: str,
        history: list[dict[str, Any]] | None,
    ) -> AgentDraft:
        """运行主 Agent Loop；此阶段只产出草稿，不返回用户结果。

        `await Runner.run(...)` 期间，SDK 会重复执行“调用 Model -> 执行 Tool -> 把 Tool
        Result 放回 Context”，直到 Model 返回 AgentDraft 或达到 max_turns。
        """

        # 纯知识问答没有 recommendation，因此 request 可以是 None。
        recommendation = task_context.recommendation
        request = recommendation.request if recommendation is not None else None

        # RunContext 是一次 Agent Loop 的共享运行时对象。
        # Tool Result 返回 Model；Evidence 留在 RunContext，仅供 Harness 校验。
        run_context = ChattyRunContext(
            request=request,
            catalog=self.catalog,
            evidence=evidence,
        )
        # 如果最终 JSON 不符合 AgentDraft，SDK 会调用这个纠正函数一次。
        error_handlers: RunErrorHandlers[ChattyRunContext] = {
            "invalid_final_output": lambda data: correct_invalid_draft(
                data, self.provider
            )
        }
        result = await Runner.run(
            build_chatty_agent(self.provider),
            _build_model_input(task_context, user_text, history),
            context=run_context,
            # 一个 turn 指一次 Model 请求，不是一次用户对话。Tool Loop 最多 12 次。
            max_turns=12,
            hooks=ChattyRunHooks(),
            run_config=RunConfig(
                # 每次调用 Model 前，都根据最新 Evidence 追加 agent_status。
                call_model_input_filter=append_agent_status,
                # Tool 串行执行，保证后一个 Tool 看见前一个 Tool 写入的 Evidence。
                tool_execution=ToolExecutionConfig(max_function_tool_concurrency=1),
            ),
            error_handlers=error_handlers,
        )
        # result.final_output 已通过 AgentDraft 的 Pydantic 运行时校验。
        record_run_usage(evidence, result.context_wrapper.usage)
        return result.final_output

    def _finalize_reply(
        self,
        task_context: TaskContext,
        evidence: RecommendationEvidence,
        draft: AgentDraft,
    ) -> Reply:
        """用 Harness Evidence 和 SQLite 把模型草稿收敛为领域 Reply。

        返回类型 Reply 是三个 Pydantic Model 的联合：KnowledgeReply、ClarifyReply 或
        RecommendationResponse。下面按 draft.action 分三条清晰路径处理。
        """

        recommendation = task_context.recommendation
        _validate_knowledge_answer(task_context, evidence, draft.answer)

        # 路径 1：只有知识问答时才能直接 answer；商品请求不能借此绕过推荐校验。
        if draft.action == "answer":
            if (
                task_context.frame.knowledge_query is None
                or recommendation is not None
                or draft.answer is None
            ):
                raise RecommendationError("invalid_draft")
            return KnowledgeReply(answer=draft.answer)

        # 路径 2：只有存在商品需求时才能 clarify，并且必需 Tool 仍要执行完。
        if draft.action == "clarify":
            if recommendation is None or draft.question is None:
                raise RecommendationError("invalid_draft")
            validate_clarification_evidence(evidence)
            return ClarifyReply(question=draft.question, answer=draft.answer)

        # 路径 3：剩下的是 recommend。必须同时有 Harness Context 和 Model 推荐项。
        if recommendation is None or draft.recommendations is None:
            raise RecommendationError("invalid_draft")
        validate_recommendation_evidence(evidence, draft.recommendations)
        if evidence.profile is None:
            raise RecommendationError("profile_not_loaded")

        # Evidence 校验集合关系，Catalog.finalize 再从 SQLite 读取最终价格和库存。
        request = recommendation.request
        products = self.catalog.finalize(
            draft.recommendations,
            request,
            evidence.profile,
        )
        # 只有成功推荐后才更新画像；回答、澄清和失败都不会写入偏好。
        self.catalog.update_user_profile_after_success(
            request.user_id,
            request.context.preferred_categories or [],
        )
        return RecommendationResponse(products=products, answer=draft.answer)


def _build_model_input(
    task_context: TaskContext,
    user_text: str,
    history: list[dict[str, Any]] | None,
) -> list[TResponseInputItem]:
    """保留用户原话，并把 Harness Context 作为独立来源注入。

    TResponseInputItem 是 OpenAI SDK 对输入消息的联合类型，作用类似 TypeScript 的
    union type。这里返回普通 list，列表元素仍会在 SDK 请求前接受类型检查。
    """

    # history 为 None 时用空列表；复制列表避免修改调用方保存的旧 Context。
    model_input = cast(list[TResponseInputItem], list(history or []))

    # 用户消息保留原话，Model 可以看到自然语言细节。
    model_input.append(
        {
            "role": "user",
            "content": [{"type": "input_text", "text": user_text}],
        }
    )
    # Harness Context 使用 developer role，明确它比用户描述更可信。
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
    return model_input


def _validate_knowledge_answer(
    task_context: TaskContext,
    evidence: RecommendationEvidence,
    answer: str | None,
) -> None:
    """知识问题必须有回答，并且 Evidence 必须记录到真实检索命中。"""

    # 没有知识问题时，这项校验与本轮无关，直接结束函数。
    if task_context.frame.knowledge_query is None:
        return
    if not answer:
        raise RecommendationError("invalid_draft")
    if evidence.general_knowledge_hits == 0:
        raise RecommendationError("knowledge_not_retrieved")


def _diagnostics(evidence: RecommendationEvidence, error: Exception) -> dict[str, Any]:
    """保留异常类型与消息，避免空消息异常在日志中变成无声失败。"""

    return {
        "evidence": snapshot_evidence(evidence).model_dump(),
        "cause_type": type(error).__name__,
        "cause": str(error),
    }
