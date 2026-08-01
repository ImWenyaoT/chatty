"""把一句大白话转成结构化的检索条件。

这是**输入适配**，不属于 Agent 本身：真正的五个工具跑在这之后，拿到的仍然是结构化
请求。放在 chatty 里而不是某个入口里，是因为终端 demo 和 Web 界面要的是同一件事——
各写一份的话，两边对「2000 以内」的理解会慢慢跑偏，而没有任何测试盯着。

这一步天生是「模型说了不算」的地方：它可能不返回 JSON、可能包在代码块里、可能返回
一个数组。解析不了就当没给条件，按原话去搜，绝不让调用方在这里崩掉。
"""

from __future__ import annotations

import json

from chatty.model_provider import ModelProvider
from chatty.models import UserContext

PARSE_PROMPT = """把用户的购物需求转成 JSON，只输出 JSON 不要别的：
{{"category": "类目名或 null", "min_yuan": 数字或 null, "max_yuan": 数字或 null}}

可选类目只有：{categories}
挑最接近的一个；实在对不上就填 null。价格用元为单位。

例：
「想买个降噪耳机，2000 以内」-> {{"category": "耳机", "min_yuan": null, "max_yuan": 2000}}
「三千以上的手机」          -> {{"category": "手机", "min_yuan": 3000, "max_yuan": null}}
"""


def _to_cents(yuan: object) -> int | None:
    return int(yuan * 100) if isinstance(yuan, int | float) else None


async def parse_need(
    provider: ModelProvider, text: str, categories: list[str]
) -> UserContext:
    """把用户说的话解析成 UserContext。解析不出来就返回空条件，不抛异常。"""
    raw = (
        await provider.complete(
            text, system=PARSE_PROMPT.format(categories="、".join(categories))
        )
        or "{}"
    )
    # 模型可能把 JSON 包在代码块里，抠出大括号那段
    start, end = raw.find("{"), raw.rfind("}")
    try:
        parsed = json.loads(raw[start : end + 1]) if start != -1 and end > start else {}
    except json.JSONDecodeError:
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}

    return UserContext(
        preferred_categories=[parsed["category"]] if parsed.get("category") in categories else [],
        min_price_cents=_to_cents(parsed.get("min_yuan")),
        max_price_cents=_to_cents(parsed.get("max_yuan")),
    )


def describe(context: UserContext) -> str:
    """把解析结果说给人听，让人看见这句话被理解成了什么。"""
    bits = list(context.preferred_categories) or ["不限类目"]
    if context.min_price_cents:
        bits.append(f"≥{context.min_price_cents / 100:.0f} 元")
    if context.max_price_cents:
        bits.append(f"≤{context.max_price_cents / 100:.0f} 元")
    return " · ".join(bits)
