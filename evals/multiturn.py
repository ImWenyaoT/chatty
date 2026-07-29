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

from agents.items import TResponseInputItem

from chatty import config
from chatty.agent import Recommender, build_model
from chatty.catalog import Catalog
from chatty.models import ClarifyReply, RecommendationRequest, UserContext

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


async def simulate_user(client, model_id: str, facts: dict[str, str], question: str) -> str:
    """模拟用户答一句话。按剧本渐进透露，不编造剧本外的信息。"""
    fact_lines = "\n".join(f"- {k}：{v}" for k, v in facts.items())
    completion = await client.chat.completions.create(
        model=model_id,
        messages=[
            {
                "role": "user",
                "content": SIMULATOR_PROMPT.format(facts=fact_lines, question=question),
            }
        ],
        extra_body={"thinking": {"type": "disabled"}},
    )
    return (completion.choices[0].message.content or "都行").strip()


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


async def run_multiturn_task(
    task: MultiTurnTask,
    catalog: Catalog,
    client,
    model_id: str,
) -> MultiTurnVerdict:
    """跑一条多轮任务：模拟用户开场 → Agent 澄清 → 模拟用户按剧本答 → 直到给出推荐。"""
    verdict = MultiTurnVerdict(task_id=task.task_id, passed=False, turns=0, clarify_count=0)
    recommender = Recommender(catalog)
    history: list[TResponseInputItem] = []
    # 用户说过的话累积起来，每轮重新解析成结构化条件
    said = [task.opening]
    verdict.transcript.append(TurnRecord("用户", task.opening))

    try:
        for _ in range(MAX_TURNS):
            verdict.turns += 1
            context = _context_from(said, task, catalog)
            request = RecommendationRequest(
                user_id=task.user_id, num_items=3, context=context
            )
            reply = await recommender.respond(request, history=history)

            if isinstance(reply, ClarifyReply):
                verdict.clarify_count += 1
                verdict.transcript.append(TurnRecord("Agent", reply.question))
                history.append({"role": "user", "content": request.model_dump_json()})
                history.append(
                    {
                        "role": "assistant",
                        "content": json.dumps(
                            {"action": "clarify", "question": reply.question},
                            ensure_ascii=False,
                        ),
                    }
                )
                answer = await simulate_user(client, model_id, task.facts, reply.question)
                said.append(answer)
                verdict.transcript.append(TurnRecord("用户", answer))
                continue

            # 给出推荐了，开始判分
            verdict.reasons = _check(task, reply, verdict)
            verdict.passed = not verdict.reasons
            verdict.transcript.append(
                TurnRecord("Agent", "推荐：" + "、".join(p.name for p in reply.products))
            )
            return verdict

        verdict.reasons.append(f"{MAX_TURNS} 轮内没给出推荐")
        return verdict
    except Exception as error:  # noqa: BLE001 — 崩了也是一种结果，记下来
        verdict.reasons.append(f"运行失败：{type(error).__name__}: {error}")
        return verdict
    finally:
        await recommender.close()


def _context_from(said: list[str], task: MultiTurnTask, catalog: Catalog) -> UserContext:
    """把用户说过的话转成结构化条件。

    这里不调模型解析，而是按剧本里的事实直接匹配——评估要的是可复现，
    多引入一次模型调用就多一层不确定性。
    """
    joined = " ".join(said)
    categories = sorted({p.category for p in catalog.products})
    hit = [c for c in categories if c in joined]
    max_cents = task.max_price_cents if _mentions_budget(joined) else None
    return UserContext(preferred_categories=hit[:1], max_price_cents=max_cents)


def _mentions_budget(text: str) -> bool:
    return any(w in text for w in ("元", "块", "预算", "以内", "以下"))


def _check(task: MultiTurnTask, reply, verdict: MultiTurnVerdict) -> list[str]:
    """双重检查：数据库状态 + 对话内容。任一不过就是 0 分。"""
    problems: list[str] = []

    # —— 数据库侧 ——
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

    # —— 对话侧 ——
    if task.max_clarify is not None and verdict.clarify_count > task.max_clarify:
        problems.append(
            f"澄清了 {verdict.clarify_count} 次，但开场信息已经够了（上限 {task.max_clarify}）"
        )
    asked = " ".join(r.text for r in verdict.transcript if r.speaker == "Agent")
    for point in task.must_ask_about:
        if point == "类目" and verdict.clarify_count == 0:
            problems.append("开场信息不足却没有澄清就直接推荐")
        elif point not in ("类目",) and point not in asked:
            problems.append(f"没有问到「{point}」")

    return problems


# ============================================================================
# 批量跑与报告
# ============================================================================


async def run_multiturn_suite(
    tasks: tuple[MultiTurnTask, ...] = ALL_MULTITURN_TASKS,
    *,
    data_dir: Path | None = None,
) -> list[MultiTurnVerdict]:
    catalog = Catalog(data_dir)
    _, client = build_model()
    model_id = config.configured_model_id()
    try:
        # 串行跑：多轮对话轮次多，并发容易撞限流，而且日志会交错难读
        return [await run_multiturn_task(t, catalog, client, model_id) for t in tasks]
    finally:
        await client.close()
        catalog.close()


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
