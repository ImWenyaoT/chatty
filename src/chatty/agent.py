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
from chatty.tools import (
    RecommendationContext,
    build_tools,
    validate_tool_sequence,
)

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

# 匹配 ```json ... ``` 这种 Markdown 代码块，用来从模型的自然语言回复里抠出 JSON。
_JSON_CODE_BLOCK = re.compile(r"```(?:json)?\s*(\{.*\})\s*```", re.DOTALL | re.IGNORECASE)


def parse_recommendation_draft(raw_output: object) -> RecommendationDraft:
    """把模型的输出解析成结构化草稿。

    因为没用 SDK 的 json_schema（见 recommend 里的说明），模型返回的是纯文本，
    它可能直接给 JSON，也可能包在 Markdown 代码块里，所以这里要逐个候选去试。
    """
    # 情况一：已经是结构化对象，直接用。
    if isinstance(raw_output, RecommendationDraft):
        return raw_output
    # 情况二：是 dict 之类的非字符串，交给 Pydantic 校验。
    if not isinstance(raw_output, str):
        return RecommendationDraft.model_validate(raw_output)

    # 情况三：是字符串。按"最可能正确"的顺序准备几个候选，逐个尝试解析。
    candidates = []

    # 候选一：Markdown 代码块里的内容。模型最常见的做法是 ```json ... ```
    if match := _JSON_CODE_BLOCK.search(raw_output):
        candidates.append(match.group(1))

    # 候选二：从第一个 { 到最后一个 } 之间的部分。
    # 这是为了兜住"模型先写一段说明文字，再给 JSON"的情况：
    # 输出可能长成「对 P012（绿联氮化镓）来说…… + 换行 + JSON 对象」这样。
    # 提示词里已经写明"只返回一个 JSON 对象"，但模型并不总是遵守，
    # 所以 Harness 必须能从掺了自然语言的输出里把结构化部分捞出来。
    start = raw_output.find("{")
    end = raw_output.rfind("}")
    if start != -1 and end > start:
        candidates.append(raw_output[start : end + 1])

    # 候选三：整段原文。模型规规矩矩只返回 JSON 时走这条。
    candidates.append(raw_output)

    for candidate in candidates:
        try:
            return RecommendationDraft.model_validate_json(candidate)
        except ValidationError:
            continue  # 这个候选解析不了，试下一个
    # 都失败了就再解析一次原文，让 Pydantic 抛出带细节的异常，便于定位。
    return RecommendationDraft.model_validate_json(raw_output)


# 重试有没有意义，是调用方最需要知道的一件事。
# 配置缺失属于环境问题，补上密钥后同样的请求就能成功；
# 其余错误都是这一轮 Agent 逻辑上没走通，原样重试大概率还是同样结果。
_RETRIABLE_CODES = frozenset({"llm_not_configured"})


class RecommendationError(RuntimeError):
    """带错误码的业务异常。

    code 是一个稳定的字符串（如 "product_not_recalled"），
    调用方靠它判断失败原因，测试也靠它断言。

    retriable 表示"原样重试是否有意义"。这个语义属于领域层而不是传输层——
    将来无论对外是 HTTP、gRPC 还是消息队列，都可以据此映射
    （例如 HTTP 下 retriable=True 对应 503、False 对应 502）。

    diagnostics 是可选的结构化上下文，只用于日志和离线评估定位根因，
    不应该暴露给外部调用方——对外只给稳定的 code。
    """

    def __init__(self, code: str, diagnostics: dict[str, object] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.retriable = code in _RETRIABLE_CODES
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
        """一次完整的推荐：跑 Agent Loop → 校验证据 → 重查数据库 → 返回响应。"""
        started = time.perf_counter()  # 用于统计端到端延迟
        # A/B 分组：同一个 user_id 永远落在同一组（哈希决定，不随机）。
        group = self.metrics.assign(request.user_id)
        # 调试钩子只在开关打开时创建，用来记录每一轮模型输入输出，便于离线复盘。
        debug_hooks = AgentDebugHooks(self._model_id) if config.agent_debug_enabled() else None
        try:
            model = self._ensure_model()
            # context 是这一次运行的"证据本"：五个工具会依次往里写自己的结果，
            # 跑完之后 Harness 靠它来判断模型是否真的走完了流程。
            context = RecommendationContext(
                request=request,
                catalog=self.catalog,
                experiment_group=group,
            )
            # DeepSeek V4 Pro 不接受 SDK 的 json_schema response_format，
            # 因此让 Chat Completions 返回纯文本，再在本地提取并校验 JSON。
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
            # ↓↓↓ 以下是 Harness 校验段：模型说它做完了不算数，要用证据证明 ↓↓↓
            # Model 决定如何调用 Tool；Harness 用可观察状态验证它是否真的完成了流程。

            # ① 五个工具都要调过，且有数据依赖的三步保持先后。
            #    允许重复调用（重搜、补充检索都是合理行为），详见 validate_tool_sequence。
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
            # 解析模型输出的 JSON 草稿（只含商品 ID、推荐理由、营销文案）。
            draft = parse_recommendation_draft(result.final_output)
            # ③ 用户画像必须成功加载，否则后面没法校验价格区间。
            #
            # 说明：走到这一步 ① 已经确认 get_user_profile 调用过了，所以 profile
            # 理论上不会是 None——这行的实际作用是**类型收窄**（让类型检查器知道
            # 下面传给 finalize 的不是 None），顺带做一层防御。
            # 真正会触发"画像未加载"的地方在 tools.py：模型如果先调 search_products，
            # 那个工具会自己抛错。
            if context.profile is None:
                raise RecommendationError("profile_not_loaded")

            # ④⑤⑥ 模型草稿只有文本建议权，商品范围必须由 Tool 留下的证据集合证明。
            # 三条检查形状相同，所以放进一张表里循环——避免三段几乎一样的 if-raise，
            # 也保证任何一条失败时都能给出同样详细的诊断信息。
            # `<=` 用在两个 set 之间是"子集判断"（不是小于等于）：
            # 推荐的商品必须全部出现在工具返回过的集合里。
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
        # ↓↓↓ 三段异常处理，从"已知业务失败"到"完全没预料到"，逐层兜底 ↓↓↓
        # 第一段：上面主动抛出的业务错误，已经带了明确错误码，原样往上抛。
        except RecommendationError as error:
            elapsed_ms = (time.perf_counter() - started) * 1000
            self.metrics.record_request(group, success=False, latency_ms=elapsed_ms)
            if debug_hooks is not None:
                debug_hooks.record_failure(error.code)
            logger.warning(
                "Recommendation failed with code=%s diagnostics=%s", error.code, error.diagnostics
            )
            raise
        # 第二段：数据层错误和 Pydantic 校验错误，内部分得细（比如商品不存在、
        # 过滤后无可用商品），但对外统一收敛成一个码，避免把内部细节暴露给调用方。
        except (CatalogError, ValidationError) as error:
            elapsed_ms = (time.perf_counter() - started) * 1000
            self.metrics.record_request(group, success=False, latency_ms=elapsed_ms)
            if debug_hooks is not None:
                debug_hooks.record_failure("invalid_recommendation")
            logger.warning("Invalid recommendation output", exc_info=True)
            raise RecommendationError("invalid_recommendation") from error
        # 第三段：兜底。任何没预料到的异常都转成带码的失败，
        # 绝不静默降级、也绝不把半成品当成功返回。
        except Exception as error:
            elapsed_ms = (time.perf_counter() - started) * 1000
            self.metrics.record_request(group, success=False, latency_ms=elapsed_ms)
            if debug_hooks is not None:
                debug_hooks.record_failure("recommendation_failed")
            logger.exception("Unexpected recommendation failure")
            raise RecommendationError("recommendation_failed") from error
