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
from agents.items import TResponseInputItem
from pydantic import ValidationError

from chatty import config
from chatty.catalog import Catalog, CatalogError
from chatty.debug import AgentDebugHooks
from chatty.models import (
    AgentDraft,
    ClarifyReply,
    RecommendationRequest,
    RecommendationResponse,
)
from chatty.tools import (
    RecommendationContext,
    build_tools,
    validate_tool_sequence,
)

logger = logging.getLogger(__name__)

# Prompt 里写的规则 Harness 都会再独立校验一遍，不能当安全边界。
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
五个 tool 调用完成后，不要再调用任何 tool——没有用来提交答案的 tool，
直接把下面这个 JSON 对象作为回复正文返回：
{"action":"recommend","recommendations":[{"product_id":"商品ID","reason":"推荐理由","marketing_copy":"营销文案"}]}

请求里没写类目时，用 get_user_profile 拿到的偏好类目去搜，不要反问。

约束
- 只推荐 tool results 中经过搜索、库存检查和知识检索的商品。
- 理由和文案必须简洁，并基于检索知识与营销策略。
- 不得编造商品、价格、库存、促销或折扣。
- 不要调用未提供的 tool。"""

# 多轮版：允许先反问再推荐。单轮场景不用这套——那里需求一次给全，
# 反问只会让本该成功的请求失败（实测会把通过率从 100% 打到 44%）。
MULTI_TURN_INSTRUCTIONS = (
    AGENT_INSTRUCTIONS.replace(
        "请求里没写类目时，用 get_user_profile 拿到的偏好类目去搜，不要反问。",
        "",
    ).rstrip()
    + """

多轮补充
这是多轮对话，用户可能一次只说一半。**类目必须清楚**，否则没法搜：
请求里没有类目、历史里也没问出来时，先反问一句把它问出来，
这一轮不要调用任何 tool，回复正文仍然是 JSON：
{"action":"clarify","question":"你想看哪一类商品？"}

已经问过一次的东西不要重复问。类目一旦清楚，就按上面的五步走完给推荐。"""
)


# 匹配 ```json ... ``` 这种 Markdown 代码块，用来从模型的自然语言回复里抠出 JSON。
_JSON_CODE_BLOCK = re.compile(r"```(?:json)?\s*(\{.*\})\s*```", re.DOTALL | re.IGNORECASE)


def parse_agent_draft(raw_output: object) -> AgentDraft:
    """把模型的输出解析成结构化草稿。

    因为没用 SDK 的 json_schema（见 recommend 里的说明），模型返回的是纯文本，
    它可能直接给 JSON，也可能包在 Markdown 代码块里，所以这里要逐个候选去试。
    """
    # 情况一：已经是结构化对象，直接用。
    if isinstance(raw_output, AgentDraft):
        return raw_output
    # 情况二：是 dict 之类的非字符串，交给 Pydantic 校验。
    if not isinstance(raw_output, str):
        return AgentDraft.model_validate(raw_output)

    # 情况三：是字符串。按"最可能正确"的顺序准备几个候选，逐个尝试解析。
    candidates = []

    # 候选一：Markdown 代码块里的内容。模型最常见的做法是 ```json ... ```
    if match := _JSON_CODE_BLOCK.search(raw_output):
        candidates.append(match.group(1))

    # 候选二：掐头去尾取 {...}，兜住模型先写一段说明再给 JSON 的情况。
    start = raw_output.find("{")
    end = raw_output.rfind("}")
    if start != -1 and end > start:
        candidates.append(raw_output[start : end + 1])

    # 候选三：整段原文。模型规规矩矩只返回 JSON 时走这条。
    candidates.append(raw_output)

    for candidate in candidates:
        try:
            return AgentDraft.model_validate_json(candidate)
        except ValidationError:
            continue  # 这个候选解析不了，试下一个
    # 都失败了就再解析一次原文，让 Pydantic 抛出带细节的异常，便于定位。
    return AgentDraft.model_validate_json(raw_output)


class RecommendationError(RuntimeError):
    """带错误码的业务异常。

    code 是一个稳定的字符串（如 "product_not_recalled"），
    调用方靠它判断失败原因，测试也靠它断言。

    diagnostics 是可选的结构化上下文，只用于日志和离线评估定位根因，
    不应该暴露给外部调用方——对外只给稳定的 code。
    """

    def __init__(self, code: str, diagnostics: dict[str, object] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.diagnostics = diagnostics or {}


def build_model() -> tuple[Model, AsyncOpenAI]:
    """按环境变量创建模型客户端，返回 (模型, 需要关闭的连接)。

    单独抽出来是为了让消融实验能复用同一套配置——
    对照组和实验组必须用**同一个模型**，否则比较的就不是"有没有 Harness"，
    而是两个模型谁强了。

    调用方负责在用完后 await client.close()。
    """
    config.load_root_env()
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        # 没配密钥属于"环境问题"，不是 Agent 逻辑错误
        raise RecommendationError("llm_not_configured")
    base_url = os.environ.get("OPENAI_BASE_URL") or config.DEFAULT_BASE_URL
    model_id = os.environ.get("MODEL_ID") or config.DEFAULT_MODEL_ID
    client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    return OpenAIChatCompletionsModel(model=model_id, openai_client=client), client


class Recommender:
    def __init__(
        self,
        catalog: Catalog,
        *,
        model: Model | None = None,
        model_id: str | None = None,
    ) -> None:
        self.catalog = catalog
        self._model = model
        self._model_id = model_id or (
            "injected-model" if model is not None else config.configured_model_id()
        )
        self._client: AsyncOpenAI | None = None

    @property
    def model_id(self) -> str:
        return self._model_id

    def _ensure_model(self) -> Model:
        """惰性创建模型客户端。

        测试时会从构造函数注入假模型（ScriptedModel），此时直接返回、完全不联网；
        只有真跑的时候才会读环境变量去建真实客户端。
        """
        if self._model is not None:
            return self._model
        self._model, self._client = build_model()
        self._model_id = os.environ.get("MODEL_ID") or config.DEFAULT_MODEL_ID
        return self._model

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()

        self.catalog.close()

    async def recommend(self, request: RecommendationRequest) -> RecommendationResponse:
        """单轮推荐：需求一次给全，模型不该反问。

        反问了就是它没按约定走，按失败处理——单轮场景没有"下一轮"来接这个问题。
        """
        reply = await self._run_turn(request, history=[])
        if isinstance(reply, ClarifyReply):
            raise RecommendationError("clarification_needed", {"question": reply.question})
        return reply

    async def respond(
        self,
        request: RecommendationRequest,
        history: list[TResponseInputItem] | None = None,
    ) -> RecommendationResponse | ClarifyReply:
        """多轮：把之前的对话一起喂进去，模型可以先反问再推荐。

        history 是 [{"role": "user"/"assistant", "content": "..."}] 的消息列表。
        """
        return await self._run_turn(request, history=history or [], allow_clarify=True)

    async def _run_turn(
        self,
        request: RecommendationRequest,
        *,
        history: list[TResponseInputItem],
        allow_clarify: bool = False,
    ) -> RecommendationResponse | ClarifyReply:
        """跑一轮：Agent Loop → 判断是澄清还是推荐 → 推荐才校验证据。"""
        started = time.perf_counter()  # 用于统计端到端延迟
        # 调试钩子只在开关打开时创建，用来记录每一轮模型输入输出，便于离线复盘。
        debug_hooks = AgentDebugHooks(self._model_id) if config.agent_debug_enabled() else None
        try:
            model = self._ensure_model()
            # context 是这次运行的证据本，五个工具往里写结果
            context = RecommendationContext(
                request=request,
                catalog=self.catalog,
            )
            # DeepSeek 不吃 json_schema，所以返回纯文本、本地提取 JSON。
            agent = Agent[RecommendationContext](
                name="Chatty",
                instructions=MULTI_TURN_INSTRUCTIONS if allow_clarify else AGENT_INSTRUCTIONS,
                model=model,
                model_settings=ModelSettings(extra_body={"thinking": {"type": "disabled"}}),
                tools=build_tools(),
            )
            # max_turns 是失控保护，不是重试策略。
            # 有历史就把历史接在前面，让模型看得到之前问过什么、用户答了什么
            turn_input: str | list[TResponseInputItem] = request.model_dump_json()
            if history:
                turn_input = [
                    *history,
                    {"role": "user", "content": request.model_dump_json()},
                ]
            result = await Runner.run(
                agent,
                turn_input,
                context=context,
                # 多轮要先判断信息够不够，比单轮多花一两轮，上限相应放宽
                max_turns=14 if allow_clarify else 10,
                hooks=debug_hooks,
                run_config=RunConfig(
                    workflow_name="Chatty recommendation",
                    tracing_disabled=True,
                ),
            )
            try:
                draft = parse_agent_draft(result.final_output)
            except ValidationError:
                # 多轮场景下，模型有时会用大白话反问而不是按 JSON 格式回。
                # 一个工具都没调，说明它是在澄清而不是在给推荐——那句话本身就是问题。
                # 这里可以降级是因为**澄清不涉及业务事实**：没有商品，也就没有
                # 价格库存可编造。单轮不给这条路（allow_clarify=False），
                # 那里的输出必须是推荐，格式错就是错。
                if allow_clarify and not context.used_tools:
                    return ClarifyReply(
                        request_id=f"request_{uuid4().hex}",
                        user_id=request.user_id,
                        question=str(result.final_output).strip()[:200],
                        total_latency_ms=(time.perf_counter() - started) * 1000,
                    )
                raise

            # 澄清轮：这一轮没给商品，也就没有证据可校验，直接把问题回给调用方。
            # 六条校验是针对"推荐"这个动作的，反问不涉及业务事实。
            if draft.action == "clarify":
                return ClarifyReply(
                    request_id=f"request_{uuid4().hex}",
                    user_id=request.user_id,
                    question=draft.question or "",
                    total_latency_ms=(time.perf_counter() - started) * 1000,
                )

            # ↓↓↓ Harness 校验段：模型说它做完了不算数，要用证据证明 ↓↓↓

            # ① 五个工具都调过，且依赖顺序正确（允许重复调用）
            if reason := validate_tool_sequence(context.used_tools):
                raise RecommendationError(
                    "required_tools_not_used",
                    {"used_tools": list(context.used_tools), "reason": reason},
                )
            # ② 知识检索必须有命中，没有依据就不允许往下生成。
            if not context.knowledge:
                raise RecommendationError(
                    "knowledge_not_retrieved",
                    {"tool_calls": list(context.call_log)},
                )
            # ③ 画像必须已加载。① 已保证工具调过，这里主要是类型收窄兼防御
            if context.profile is None:
                raise RecommendationError("profile_not_loaded")

            # ④⑤⑥ 三条形状相同的证据检查，放进表里循环。
            # 两个 set 之间的 `<=` 是子集判断，不是小于等于。
            recommended_ids = {item.product_id for item in draft.recommendations}
            evidence_checks = (
                # 错误码, 证据集合, 这份证据是哪个工具留下的
                ("product_not_recalled", context.recalled_product_ids, "search_products"),
                ("inventory_not_checked", context.in_stock_product_ids, "check_inventory"),
                ("product_not_grounded", context.knowledge_product_ids, "retrieve_knowledge"),
            )
            for code, evidence, source_tool in evidence_checks:
                if not recommended_ids <= evidence:
                    raise RecommendationError(
                        code,
                        {
                            "recommended": sorted(recommended_ids),
                            # 缺的是哪几个商品——定位时最先要看的就是这个
                            "missing": sorted(recommended_ids - evidence),
                            "evidence": sorted(evidence),
                            "evidence_from": source_tool,
                            "tool_calls": list(context.call_log),
                        },
                    )
            # 校验都通过后，重新查一次数据库，用库里的真实值覆盖价格、库存、商品名，
            # 并对模型写的理由和文案做禁词替换。详见 catalog.finalize。
            products = self.catalog.finalize(
                draft,
                request,
                context.profile,
            )
            elapsed_ms = (time.perf_counter() - started) * 1000
            response = RecommendationResponse(
                request_id=f"request_{uuid4().hex}",
                user_id=request.user_id,
                products=products,
                total_latency_ms=elapsed_ms,
            )
            if debug_hooks is not None:
                debug_hooks.record_response(response)
            return response
        # ↓↓↓ 三段异常处理，从"已知业务失败"到"完全没预料到"，逐层兜底 ↓↓↓
        # 第一段：上面主动抛出的业务错误，已经带了明确错误码，原样往上抛。
        except RecommendationError as error:
            if debug_hooks is not None:
                debug_hooks.record_failure(error.code)
            logger.warning(
                "Recommendation failed with code=%s diagnostics=%s", error.code, error.diagnostics
            )
            raise
        # 第二段：数据层错误和 Pydantic 校验错误，内部分得细（比如商品不存在、
        # 过滤后无可用商品），但对外统一收敛成一个码，避免把内部细节暴露给调用方。
        except (CatalogError, ValidationError) as error:
            if debug_hooks is not None:
                debug_hooks.record_failure("invalid_recommendation")
            logger.warning("Invalid recommendation output", exc_info=True)
            raise RecommendationError("invalid_recommendation") from error
        # 第三段：兜底。任何没预料到的异常都转成带码的失败，
        # 绝不静默降级、也绝不把半成品当成功返回。
        except Exception as error:
            if debug_hooks is not None:
                debug_hooks.record_failure("recommendation_failed")
            logger.exception("Unexpected recommendation failure")
            raise RecommendationError("recommendation_failed") from error
