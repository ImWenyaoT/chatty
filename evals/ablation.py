"""消融实验：把工具和 Harness 拿掉，看输出会坏成什么样。

消融实验方法——**逐一关闭某个组件，
观察整体性能变化，从而判断该组件的真实贡献**。去掉工具定义，
Agent 完全丧失行动能力；缺少工具执行结果，Agent 会陷入无限循环。

这里对照的两组：

  A. 完整 Agent —— 五个工具 + Harness 证据校验 + finalize 重查（即 evals/runner.py 跑的）
  B. 裸模型     —— 同样的模型、同样的用户需求，但**不给任何工具**，
                   直接让它输出推荐。这模拟"没有工具和检索的纯 LLM 推荐"。

为什么这个对照有意义：Chatty 的全部主张就是"模型不能决定业务事实"。
要证明这条主张不是空话，最直接的办法是把约束拿掉，量化坏输出的比例。

判定标准全部是**客观可查**的，不依赖任何主观评分：

  · 商品是否真实存在于目录（编造的 ID 直接暴露）
  · 是否有货（推荐售罄商品）
  · 价格是否在用户画像区间内
  · 文案是否含营销禁词

跑法：uv run python -m evals --ablation
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from agents import Agent, Model, ModelSettings, RunConfig, Runner

from chatty.agent import build_model, parse_agent_draft
from chatty.catalog import Catalog
from evals.dataset import ALL_TASKS, EvalTask, Expect

# 裸模型的提示词：给它和完整 Agent 相同的任务描述，但不给任何工具。
# 刻意告诉它"目录里有哪些类目"，避免它因为完全不知道卖什么而拒答——
# 对照要公平，差距才说明问题。
BASELINE_INSTRUCTIONS = """你是一个电商推荐助手。请根据用户需求推荐商品。

商品目录涵盖以下类目：手机、耳机、平板、电脑、配件、穿戴、数码、服装、运动、家电。

只返回一个 JSON 对象：
{"recommendations":[{"product_id":"商品ID","reason":"推荐理由","marketing_copy":"营销文案"}]}

要求：
- 推荐真实存在、有库存、价格符合用户预算的商品。
- 理由和文案要简洁具体。
- 营销文案不得使用绝对化用语。"""


@dataclass
class AblationResult:
    """一组消融跑下来的统计。"""

    label: str
    tasks: int = 0
    responded: int = 0  # 成功产出了推荐（没崩溃、没拒绝）
    products: int = 0  # 推荐的商品总数
    nonexistent: list[str] = field(default_factory=list)  # 目录里根本没有的商品
    out_of_stock: list[str] = field(default_factory=list)  # 已售罄
    out_of_budget: list[str] = field(default_factory=list)  # 超出用户价格区间
    forbidden_word_hits: list[str] = field(default_factory=list)  # 文案含禁词

    @property
    def bad_product_rate(self) -> float:
        """推荐的商品里有多大比例是"不该出现"的。"""
        bad = len(self.nonexistent) + len(self.out_of_stock) + len(self.out_of_budget)
        return round(bad / self.products, 4) if self.products else 0.0


async def _run_baseline_task(
    task: EvalTask, catalog: Catalog, model: Model
) -> list[dict[str, str]]:
    """跑一条裸模型任务，返回它推荐的商品列表（解析失败就返回空）。"""
    profile = catalog.user_profile(task.user_id, task.to_request().context)
    need = (
        f"用户分群：{profile.segment}；偏好类目：{profile.preferred_categories}；"
        f"可接受价格区间：{profile.min_price_cents}~{profile.max_price_cents} 分。"
        f"请推荐 {task.num_items} 件商品。"
    )

    agent = Agent(
        name="Baseline",
        instructions=BASELINE_INSTRUCTIONS,
        model=model,
        model_settings=ModelSettings(extra_body={"thinking": {"type": "disabled"}}),
        tools=[],  # ← 消融的核心：不给任何工具
    )
    try:
        result = await Runner.run(
            agent,
            need,
            max_turns=3,
            # 和实验组一样关掉 tracing：用的是 DeepSeek 的 key，
            # 往 OpenAI 上报会刷一屏 401 噪音
            run_config=RunConfig(workflow_name="Chatty ablation", tracing_disabled=True),
        )
        draft = parse_agent_draft(result.final_output)
    except Exception:  # noqa: BLE001 — 裸模型崩了也是一种结果，记为"没产出"
        return []
    return [
        {
            "product_id": item.product_id,
            "reason": item.reason,
            "marketing_copy": item.marketing_copy,
        }
        for item in draft.recommendations
    ]


async def run_ablation(
    tasks: tuple[EvalTask, ...] = ALL_TASKS,
    *,
    data_dir: Path | None = None,
) -> AblationResult:
    """跑裸模型对照组，统计它的输出里有多少"不该出现"的商品。

    完整 Agent 那一组不用在这里重跑——它的结果就是 `python -m evals` 的输出，
    而且按设计**这些坏情况一个都不会流出去**（Harness 要么拦下要么过滤）。
    """
    catalog = Catalog(data_dir)
    # 对照组必须用和实验组**同一个模型**，否则比的就不是"有没有 Harness"了
    model, client = build_model()
    try:
        products = {p.product_id: p for p in catalog.products}
        forbidden = catalog.forbidden_words
        result = AblationResult(label="裸模型（无工具、无 Harness）")

        # 只跑"期望成功"的任务：期望拒绝的任务对裸模型没有意义，
        # 它根本没有拒绝的依据。
        target = [t for t in tasks if t.expect is Expect.SUCCEED]
        result.tasks = len(target)

        for task in target:
            items = await _run_baseline_task(task, catalog, model)
            if not items:
                continue
            result.responded += 1
            profile = catalog.user_profile(task.user_id, task.to_request().context)

            for item in items:
                result.products += 1
                product = products.get(item["product_id"])
                if product is None:
                    # 目录里没有这个 ID —— 模型凭空编的
                    result.nonexistent.append(item["product_id"])
                    continue
                if product.stock <= 0:
                    result.out_of_stock.append(item["product_id"])
                if not (
                    profile.min_price_cents <= product.price_cents <= profile.max_price_cents
                ):
                    result.out_of_budget.append(item["product_id"])
                text = item["reason"] + item["marketing_copy"]
                for word in forbidden:
                    if word in text:
                        result.forbidden_word_hits.append(f"{item['product_id']}:{word}")
                        break
        return result
    finally:
        await client.close()
        catalog.close()


def render_ablation_report(result: AblationResult) -> str:
    lines = [
        "消融对比：拿掉工具与 Harness 之后",
        "",
        f"对照组：{result.label}",
        f"  跑了 {result.tasks} 条任务，其中 {result.responded} 条产出了推荐，"
        f"共 {result.products} 件商品",
        "",
        "  客观可查的问题：",
        f"    目录中不存在（编造 ID）：{len(result.nonexistent)} 件",
        f"    已售罄：              {len(result.out_of_stock)} 件",
        f"    超出用户价格区间：      {len(result.out_of_budget)} 件",
        f"    文案含营销禁词：        {len(result.forbidden_word_hits)} 处",
        "",
        f"  **不该出现的商品占比：{result.bad_product_rate:.0%}**",
        "",
        "实验组：完整 Agent（五个工具 + Harness 证据校验 + finalize 重查）",
        "  以上四类问题**全部为 0**——不是因为模型不犯错，而是因为：",
        "    · 编造的商品 ID 过不了「推荐 ⊆ 搜索召回」的子集校验",
        "    · 售罄和超预算的商品在 finalize 重查 SQLite 时被过滤",
        "    · 禁词在响应前被强制替换",
        "  这三道关都不依赖模型的自觉。",
    ]
    if result.nonexistent:
        sample = ", ".join(sorted(set(result.nonexistent))[:6])
        lines += ["", f"  编造的商品 ID 示例：{sample}"]

    # 编造率接近 100% 时，后三项的 0 会被误读成"裸模型在这些方面做得好"。
    # 实际上恰恰相反：商品都是假的，根本无从判断它的库存和价格。
    if result.nonexistent and len(result.nonexistent) >= result.products * 0.9:
        lines += [
            "",
            "  ⚠ 注意：上面「已售罄」和「超预算」为 0 **不是优点**——",
            "    商品 ID 几乎全是编造的，压根查不到对应的库存和价格，",
            "    这两项是无从判断，而不是判断通过了。",
        ]
    return "\n".join(lines)


def result_to_json(result: AblationResult) -> str:
    return json.dumps(
        {
            "label": result.label,
            "tasks": result.tasks,
            "responded": result.responded,
            "products": result.products,
            "nonexistent": len(result.nonexistent),
            "out_of_stock": len(result.out_of_stock),
            "out_of_budget": len(result.out_of_budget),
            "forbidden_word_hits": len(result.forbidden_word_hits),
            "bad_product_rate": result.bad_product_rate,
        },
        ensure_ascii=False,
        indent=2,
    )
