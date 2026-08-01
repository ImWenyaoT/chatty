"""多轮评估：用户模拟器 + 渐进式信息透露。

单轮任务集（dataset.py）假设需求一次给全，测的是「拿到完整需求后能不能做对」。
这里测的是另一件事：**需求只说一半时，Agent 会不会把缺的问出来**。

设计照 τ-bench 那套：

    任务定义 = 已知信息 + 透露规则 + 成功条件

关键是**渐进式信息透露**——绝不能一开始就把模拟用户的全部信息倒给 Agent。
真实用户不会一上来就说「我要买 2000 元以内的降噪耳机用于地铁通勤」，
他只会说「想买个耳机」。Agent 得自己把预算和场景问出来，
这个过程本身就是能力的一部分。

成功条件用双重检查（也是 τ-bench 的做法）：
  · 数据库状态 —— 推荐的商品必须真实存在、符合价格与类目约束
  · 对话内容 —— Agent 必须问到过关键信息，且回复里提到了场景关键词

模拟用户本身是个 LLM，它的质量需要单独验证——见 README 里
「模拟器怎么验」一节。这里通过两个约束尽量减少它的自由发挥：
剧本写死已知信息，提示词要求「只回答被问到的那一项，不要主动补充」。
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path

from chatty.agent import Recommender
from chatty.conversation import Conversation
from chatty.model_provider import EnvModelProvider, ModelProvider
from chatty.models import RecommendationResponse, UserContext
from evals.session import SessionOutcome, run_session

# ============================================================================
# 任务定义
# ============================================================================


@dataclass(frozen=True)
class MultiTurnTask:
    """一条多轮任务。

    已知信息（facts）是模拟用户「心里知道但不会主动说」的东西，
    只有被问到对应的点才透露；opening 是它第一句话，刻意说得不全。
    """

    task_id: str
    intent: str  # 这条在测什么，给人看的
    user_id: str
    opening: str  # 用户开场白，信息刻意不全
    facts: dict[str, str]  # 被问到才说：{"预算": "2000 元以内", ...}

    # —— 成功条件：数据库侧 ——
    expect_category: str  # 最终推荐必须落在这个类目
    max_price_cents: int | None = None  # 推荐商品的价格上限
    banned_product_ids: frozenset[str] = frozenset()

    # —— 成功条件：对话侧 ——
    # Agent 至少要问到其中一个点（否则说明它没澄清就瞎推荐）
    must_ask_about: frozenset[str] = frozenset()
    # 澄清次数上限；None 表示不限。设 0 就是「信息已经够了，不该反问」
    max_clarify: int | None = None


ALL_MULTITURN_TASKS: tuple[MultiTurnTask, ...] = (
    # 设计这几条时先撞了一次墙：十个画像**全都有偏好类目**，所以只要用户不说，
    # Agent 就能拿画像兜底直接推荐——那是合理行为，不是缺陷。
    # 所以「开场什么都不说」根本测不出澄清能力，得换成画像也帮不上忙的情况：
    # 用户说了目录里没有的东西，或者说法太含糊导致映射不过去。
    MultiTurnTask(
        task_id="M1",
        intent="用户要的「空调」目录里没有，只有「家电」这一级——该问清楚而不是硬塞",
        user_id="user_new",
        opening="想买个空调",
        facts={"类目": "那看家电吧", "预算": "1000 元以内"},
        expect_category="家电",
        must_ask_about=frozenset({"类目"}),
    ),
    MultiTurnTask(
        task_id="M2",
        intent="类目一开始就明确，不该多此一问，应当直接给推荐",
        user_id="user_budget",
        opening="想看看家电",
        facts={"预算": "500 元以内就行"},
        expect_category="家电",
        # 画像本身是价格敏感型，价格约束由画像兜底，不靠对话问出来
        max_clarify=0,
    ),
    MultiTurnTask(
        task_id="M3",
        intent="说法含糊（「听歌的」不是类目名），但画像里有耳机偏好——用画像兜底直接推也算对",
        user_id="user_active",
        opening="想找个听歌用的",
        facts={"类目": "耳机", "预算": "不限"},
        expect_category="耳机",
    ),
)


# ============================================================================
# 用户模拟器
# ============================================================================

SIMULATOR_PROMPT = """你在扮演一个网购用户，正在和客服 Agent 对话。

你心里知道这些信息，但**只有被问到对应的那一项时才说出来**：
{facts}

规则：
- 一次只回答被问到的那一项，不要主动补充其他信息
- 回答要短，像真人说话，不要用 JSON 或列表
- 没被问到的信息绝对不能提前说出来
- 如果对方问的东西你不知道，就说「随便」或「都行」

对方刚才说：{question}

用一句话回答他。"""


async def simulate_user(
    provider: ModelProvider, facts: dict[str, str], question: str
) -> str:
    """模拟用户答一句话。按剧本渐进透露，不编造剧本外的信息。"""
    fact_lines = "\n".join(f"- {k}：{v}" for k, v in facts.items())
    reply = await provider.complete(
        SIMULATOR_PROMPT.format(facts=fact_lines, question=question)
    )
    return reply.strip() or "都行"


# ============================================================================
# 跑一条 + 判分
# ============================================================================


@dataclass
class TurnRecord:
    """一轮里发生了什么，便于事后人工抽查模拟器质量。"""

    speaker: str
    text: str


@dataclass
class MultiTurnVerdict:
    task_id: str
    passed: bool
    turns: int
    clarify_count: int
    reasons: list[str] = field(default_factory=list)
    transcript: list[TurnRecord] = field(default_factory=list)


MAX_TURNS = 4  # 超过就算它绕不出来


@dataclass
class MultiTurnEvidence:
    """会话过程中攒下的证据，由 run_multiturn_task 的回调逐轮填。

    Conversation 不认识「评估证据」这个概念——每次澄清恰好调用一次 ask 回调，
    所以想记什么在回调里记，会话中途抛异常了这些记录也还在手上。
    """

    transcript: list[TurnRecord] = field(default_factory=list)
    clarify_count: int = 0
    turns: int = 0
    # 目录里真实存在的类目，判分时要用（见 _check_dialogue 的「类目」一项）
    categories: list[str] = field(default_factory=list)


async def run_multiturn_task(
    task: MultiTurnTask,
    provider: ModelProvider,
    *,
    data_dir: Path | None = None,
) -> MultiTurnVerdict:
    """跑一条多轮任务：模拟用户开场 → Agent 澄清 → 模拟用户按剧本答 → 直到给出推荐。

    环境隔离、模型注入和异常分码都在 run_session 里，会话循环在 Conversation 里；
    这里只剩两件多轮特有的事：怎么把用户的话变成条件，以及怎么答 Agent 的反问。
    """
    evidence = MultiTurnEvidence(transcript=[TurnRecord("用户", task.opening)])

    async def session(recommender: Recommender):
        async def resolve(said: list[str]) -> UserContext:
            evidence.turns += 1
            evidence.categories = recommender.catalog.categories
            return _context_from(said, task, evidence.categories)

        async def ask(question: str) -> str:
            evidence.clarify_count += 1
            evidence.transcript.append(TurnRecord("Agent", question))
            answer = await simulate_user(provider, task.facts, question)
            evidence.transcript.append(TurnRecord("用户", answer))
            return answer

        return await Conversation(
            recommender,
            user_id=task.user_id,
            resolve=resolve,
            num_items=3,
            max_turns=MAX_TURNS,
        ).converse(task.opening, ask=ask)

    outcome = await run_session(session, provider=provider, data_dir=data_dir)
    if isinstance(outcome.reply, RecommendationResponse):
        evidence.transcript.append(
            TurnRecord("Agent", "推荐：" + "、".join(p.name for p in outcome.reply.products))
        )
    return grade_multiturn(task, outcome, evidence)


def _context_from(said: list[str], task: MultiTurnTask, categories: list[str]) -> UserContext:
    """把用户说过的话转成结构化条件。

    这里不调模型解析，而是按剧本里的事实直接匹配——评估要的是可复现，
    多引入一次模型调用就多一层不确定性。
    """
    joined = " ".join(said)
    hit = [c for c in categories if c in joined]
    # 预算只有在用户真的说出来之后才生效：没问出来就该由画像兜底。
    max_cents = task.max_price_cents if _mentions_budget(joined) else None
    return UserContext(preferred_categories=hit[:1], max_price_cents=max_cents)


def _mentions_budget(text: str) -> bool:
    return any(w in text for w in ("元", "块", "预算", "以内", "以下"))


# ============================================================================
# 判分
# ============================================================================


def grade_multiturn(
    task: MultiTurnTask,
    outcome: SessionOutcome,
    evidence: MultiTurnEvidence,
) -> MultiTurnVerdict:
    """纯函数：任务定义 + 会话结果 + 会话证据 → 裁决。

    双重检查（τ-bench 的做法）：数据库状态 + 对话内容。任一不过就是 0 分。
    只有真的给出推荐时才查对话——没走到推荐就没有「问得对不对」可言。
    """
    verdict = MultiTurnVerdict(
        task_id=task.task_id,
        passed=False,
        turns=evidence.turns,
        clarify_count=evidence.clarify_count,
        transcript=list(evidence.transcript),
    )

    if outcome.error_code is not None:
        verdict.reasons.append(f"运行失败：{outcome.error_code}")
    elif not isinstance(outcome.reply, RecommendationResponse):
        verdict.reasons.append(f"{MAX_TURNS} 轮内没给出推荐")
    else:
        verdict.reasons.extend(_check_products(task, outcome.reply))
        verdict.reasons.extend(_check_dialogue(task, evidence))

    verdict.passed = not verdict.reasons
    return verdict


def _check_products(task: MultiTurnTask, reply: RecommendationResponse) -> list[str]:
    """数据库侧：推荐出来的商品对不对。"""
    problems: list[str] = []
    if not reply.products:
        problems.append("没有推荐任何商品")
    for item in reply.products:
        if item.category != task.expect_category:
            problems.append(
                f"{item.product_id} 类目是 {item.category}，应为 {task.expect_category}"
            )
        if task.max_price_cents and item.price_cents > task.max_price_cents:
            problems.append(
                f"{item.product_id} 价格 {item.price_cents / 100:.0f} 元超出上限 "
                f"{task.max_price_cents / 100:.0f} 元"
            )
        if item.product_id in task.banned_product_ids:
            problems.append(f"{item.product_id} 在禁止列表里")
    return problems


def _check_dialogue(task: MultiTurnTask, evidence: MultiTurnEvidence) -> list[str]:
    """对话侧：该问的问了没有，不该问的有没有多问。"""
    problems: list[str] = []
    if task.max_clarify is not None and evidence.clarify_count > task.max_clarify:
        problems.append(
            f"澄清了 {evidence.clarify_count} 次，但开场信息已经够了（上限 {task.max_clarify}）"
        )
    asked = " ".join(r.text for r in evidence.transcript if r.speaker == "Agent")
    for point in task.must_ask_about:
        # 「类目」是个例外：Agent 反问时不会说「类目」这两个字，它会照提示词的要求
        # **把可选类目列出来**（见 MULTI_TURN_INSTRUCTIONS 情况 A）。所以这一项查的是
        # 问句里有没有真实类目名。
        #
        # 早先这里只判 `clarify_count == 0`——只要反问过就算通过，压根不看问了什么。
        # M1 是唯一用到 must_ask_about 的任务，走的正好是这条不检查内容的分支，
        # 于是 Agent 反问「你预算多少」也能拿满分。
        if point == "类目":
            if not any(category in asked for category in evidence.categories):
                problems.append("反问时没有把可选类目列给用户")
        elif point not in asked:
            problems.append(f"没有问到「{point}」")
    return problems


# ============================================================================
# 批量跑与报告
# ============================================================================


async def run_multiturn_suite(
    tasks: tuple[MultiTurnTask, ...] = ALL_MULTITURN_TASKS,
    *,
    data_dir: Path | None = None,
    provider: ModelProvider | None = None,
) -> list[MultiTurnVerdict]:
    """跑整个多轮任务集。

    provider 是唯一的注入口，不传就按环境变量连真实模型。Agent 那一侧和用户
    模拟器共用它——两者本来就该是同一个模型，此前分成两条路各自建客户端。
    传替身就能完全离线跑：多轮评估此前没有这条路，因此一个测试都没有。
    """
    owns_provider = provider is None
    provider = provider or EnvModelProvider()
    try:
        # 串行跑：多轮对话轮次多，并发容易撞限流，而且日志会交错难读
        return [await run_multiturn_task(t, provider, data_dir=data_dir) for t in tasks]
    finally:
        # 只关自己建的：注入进来的 provider 归调用方管
        if owns_provider:
            await provider.close()


def render_multiturn_report(verdicts: list[MultiTurnVerdict]) -> str:
    passed = sum(1 for v in verdicts if v.passed)
    lines = [
        f"多轮评估：{passed}/{len(verdicts)} 通过",
        "",
    ]
    for v in verdicts:
        mark = "✓" if v.passed else "✗"
        lines.append(f"  {mark} {v.task_id}  {v.turns} 轮（澄清 {v.clarify_count} 次）")
        for reason in v.reasons:
            lines.append(f"      问题：{reason}")
    lines += [
        "",
        "对话记录（用来人工抽查模拟器有没有提前泄露信息）：",
    ]
    for v in verdicts:
        lines.append(f"\n  ── {v.task_id} ──")
        for record in v.transcript:
            lines.append(f"    {record.speaker}：{record.text}")
    return "\n".join(lines)


def multiturn_to_json(verdicts: list[MultiTurnVerdict]) -> str:
    return json.dumps(
        {
            "total": len(verdicts),
            "passed": sum(1 for v in verdicts if v.passed),
            "tasks": [
                {
                    "task_id": v.task_id,
                    "passed": v.passed,
                    "turns": v.turns,
                    "clarify_count": v.clarify_count,
                    "reasons": v.reasons,
                    "transcript": [{"speaker": r.speaker, "text": r.text} for r in v.transcript],
                }
                for v in verdicts
            ],
        },
        ensure_ascii=False,
        indent=2,
    )


__all__ = [
    "ALL_MULTITURN_TASKS",
    "MultiTurnTask",
    "MultiTurnVerdict",
    "multiturn_to_json",
    "render_multiturn_report",
    "run_multiturn_suite",
]


if __name__ == "__main__":
    print(render_multiturn_report(asyncio.run(run_multiturn_suite())))
