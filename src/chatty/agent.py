from __future__ import annotations

import logging
import re
import time
from uuid import uuid4

from agents import Agent, Runner
from agents.items import TResponseInputItem
from pydantic import ValidationError

from chatty import config
from chatty.catalog import Catalog, CatalogError
from chatty.debug import AgentDebugHooks
from chatty.model_provider import (
    EnvModelProvider,
    MissingCredentials,
    ModelProvider,
    run_config,
    run_settings,
)
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
#
# 结构上必须写成两个**互斥**的阶段。早先的写法是在单轮提示词后面追加一段
# 「多轮补充」，结果模型在「按顺序调五个 tool」和「澄清时不要调 tool」之间
# 摇摆：调一次 get_user_profile、又想澄清、又去调 get_user_profile……
# 实测三次运行只调出 4 次 get_user_profile，一次 search_products 都没有，
# 最后撞满轮次上限。互斥的措辞消除了这个歧义。
MULTI_TURN_INSTRUCTIONS = (
    AGENT_INSTRUCTIONS.replace(
        "请求里没写类目时，用 get_user_profile 拿到的偏好类目去搜，不要反问。",
        "",
    ).rstrip()
    + """

多轮补充（这段覆盖上面的「执行」一节）
这是多轮对话，用户可能一次只说一半。每一轮**二选一**，不要混着来：

情况 A —— 请求里没有类目，历史里也没问出来，画像里也没有偏好类目：
    这一轮**一个 tool 都不要调**，直接返回：
    {"action":"clarify","question":"你想看哪一类商品？我们有：<把下面的类目列出来>"}
    返回后这一轮就结束了，等用户回答。

    **反问时必须把可选类目列给用户**，不要问目录里没有的东西
    （目录只到「家电」这一级，没有「冰箱」「空调」这种子类）。
    可选类目只有这些：{categories}

情况 B —— 类目已经清楚（请求里有，或历史里用户答过）：
    **不要再反问**，按上面「执行」一节的五步依次调用 tool，然后返回 recommend。
    一旦开始调 tool 就走完五步，中途不要改回 clarify。
    **每一轮都要重新把五个 tool 走一遍**，哪怕历史里调过。
    上一轮的工具结果不能拿来当这一轮的依据——库存和价格随时会变。

判断只做一次，在这一轮的最开头。已经问过的东西不要重复问。"""
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


class Recommender:
    def __init__(
        self,
        catalog: Catalog,
        *,
        provider: ModelProvider | None = None,
    ) -> None:
        self.catalog = catalog
        # 不传就按环境变量连真实模型。测试注入 StaticModelProvider，完全不联网。
        self._provider = provider if provider is not None else EnvModelProvider()
        self._owns_provider = provider is None

    @property
    def model_id(self) -> str:
        """报告里印的模型 id。它和实际推理用的模型来自同一个提供方，不会对不上。"""
        return self._provider.model_id

    def _instructions(self, allow_clarify: bool) -> str:
        """多轮版要把真实类目填进去，否则模型会反问目录里不存在的子类目。"""
        if not allow_clarify:
            return AGENT_INSTRUCTIONS
        categories = sorted({product.category for product in self.catalog.products})
        # 用 replace 不用 format：提示词里有 JSON 大括号，format 会把它们当占位符
        return MULTI_TURN_INSTRUCTIONS.replace("{categories}", "、".join(categories))

    async def close(self) -> None:
        """只释放自己创建的东西。

        catalog 和注入进来的 provider 都由建它们的人关——所有权写进接口，
        不做隐式约定。早先这里顺手 `self.catalog.close()`，于是共享同一个 Catalog
        的调用方（多轮评估串行跑三条任务）在第一条跑完就被关掉了 sqlite 连接，
        后面两条撞 ProgrammingError，被上层的 except Exception 吞成"任务未通过"。
        """
        if self._owns_provider:
            await self._provider.close()

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
        debug_hooks = AgentDebugHooks(self.model_id) if config.agent_debug_enabled() else None
        try:
            model = self._provider.model()
            # context 是这次运行的证据本，五个工具往里写结果。
            # 多轮时每轮新建，证据**不跨轮累积**——这是个刻意的取舍：
            # 累积的话轮次越多约束越松（第 10 轮时几乎所有商品都「有过证据」），
            # 六条校验会形同虚设；不累积的代价是每轮都要重跑五个工具。
            # 正确性优先于开销，所以选了不累积。
            context = RecommendationContext(
                request=request,
                catalog=self.catalog,
            )
            # DeepSeek 不吃 json_schema，所以返回纯文本、本地提取 JSON。
            agent = Agent[RecommendationContext](
                name="Chatty",
                instructions=self._instructions(allow_clarify),
                model=model,
                model_settings=run_settings(),
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
                max_turns=18 if allow_clarify else 10,
                hooks=debug_hooks,
                run_config=run_config("Chatty recommendation"),
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
        except MissingCredentials as error:
            # 没配密钥是环境问题，不是 Agent 逻辑错误，保留它自己的码
            if debug_hooks is not None:
                debug_hooks.record_failure("llm_not_configured")
            raise RecommendationError("llm_not_configured") from error
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
