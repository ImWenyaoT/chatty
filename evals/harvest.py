"""把失败轨迹收成回归用例。

这是可观测性和评估之间的接口。可观测性负责「看见」跑的时候发生了什么，
评估负责把这些观察固化成可反复检验的标准——今天暴露的失败模式，
明天就该成为守住这条底线的回归用例。

闭环三步：

    跑的时候失败 → 失败轨迹（chatty.failure_log）→ harvest 生成 EvalTask

没有这个接口，评估集就是一次性构造的静态集合，只能覆盖当初想得到的情况；
有了它，评估集随着实际使用不断长出新用例。

日志的位置、格式和脱敏规则都归 `chatty.failure_log` 管——写它的是生产路径，
这里只是读。所以这个文件里没有任何 json 解析和路径常量。
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from chatty import config
from chatty.failure_log import read


@dataclass(frozen=True)
class HarvestedCase:
    """一条从失败里长出来的候选用例。"""

    user_id: str
    categories: tuple[str, ...]
    min_price_cents: int | None
    max_price_cents: int | None
    num_items: int
    error_code: str
    seen: int  # 这个组合失败过几次——出现越多越该补进评估集

    def to_task_code(self, index: int) -> str:
        """生成可以直接粘进 dataset.py 的代码。

        期望写成 REFUSE 还是 SUCCEED 要人来定：Harness 拦下非法请求是对的
        （应当 REFUSE），而合法请求挂掉是缺陷（应当 SUCCEED，现在挂说明有 bug）。
        机器分不清这两者，所以这里只给骨架并把错误码标在注释里。
        """
        parts = [
            "    EvalTask(",
            f'        task_id="H{index}",',
            "        level=Level.L2,",
            f'        intent="从实际运行中收来：{self.error_code}，出现过 {self.seen} 次",',
            f'        user_id="{self.user_id}",',
            "        expect=Expect.REFUSE,  # ← 确认这个请求本就该被拒；若不该，改成 SUCCEED",
        ]
        if self.categories:
            parts.append(f"        categories={list(self.categories)!r},")
        if self.min_price_cents is not None:
            parts.append(f"        min_price_cents={self.min_price_cents},")
        if self.max_price_cents is not None:
            parts.append(f"        max_price_cents={self.max_price_cents},")
        if self.num_items != 3:
            parts.append(f"        num_items={self.num_items},")
        parts.append(f'        allowed_error_codes=frozenset({{"{self.error_code}"}}),')
        parts.append("    ),")
        return "\n".join(parts)


def harvest(log_path: Path | None = None) -> list[HarvestedCase]:
    """读失败轨迹，按「请求形状 + 错误码」去重，按出现次数排序。

    去重的意义：同一个坑踩一百次也只需要一条回归用例，
    但踩的次数说明它有多值得补——所以次数要留着。
    """
    counter: Counter[tuple] = Counter()
    for entry in read(log_path):
        raw_context = entry.request.get("context")
        context = raw_context if isinstance(raw_context, dict) else {}
        categories = context.get("preferred_categories")
        counter[
            (
                entry.request.get("user_id", "user_active"),
                tuple(categories) if isinstance(categories, list) else (),
                context.get("min_price_cents"),
                context.get("max_price_cents"),
                entry.request.get("num_items", 3),
                entry.error_code,
            )
        ] += 1

    return [
        HarvestedCase(
            user_id=key[0],
            categories=key[1],
            min_price_cents=key[2],
            max_price_cents=key[3],
            num_items=key[4],
            error_code=key[5],
            seen=count,
        )
        for key, count in counter.most_common()
    ]


def render_harvest_report(cases: list[HarvestedCase]) -> str:
    if not cases:
        return (
            "还没有收到失败记录。\n"
            f"跑 demo 或评估时如果出现失败，会写进 {config.FAILURE_LOG_PATH}，再回来跑这个命令。"
        )
    total = sum(c.seen for c in cases)
    lines = [
        f"从 {total} 次失败里收出 {len(cases)} 条候选用例（按出现次数排序）",
        "",
        "把下面的代码粘进 evals/dataset.py 的 ALL_TASKS，",
        "**逐条确认 expect 该是 REFUSE 还是 SUCCEED** 之后再合并：",
        "",
    ]
    for index, case in enumerate(cases, 1):
        lines.append(case.to_task_code(index))
    return "\n".join(lines)


__all__ = ["HarvestedCase", "harvest", "render_harvest_report"]
