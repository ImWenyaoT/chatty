"""评估报告。

评估的价值不是"给出一个总分"，而是**能诊断出具体的能力短板**。
所以报告分三层：

1. **总成功率** —— 二元奖励的平均，一个数字概括整体
2. **分难度成功率** —— L1 掉分说明基础工具调用有问题，L3 掉分说明抗干扰弱，
   两者对应完全不同的改进方向（提示工程 vs Harness 约束）
3. **失败分布** —— 按维度和错误码聚合，直接指出该修哪里

刻意**没有**做的事：不算平均分。三个维度是布尔的、量纲不同，
把"政策合规"和"信息完整"加权平均成一个 3.7 分没有任何可操作含义。
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import asdict, dataclass, field

from evals.rubric import DIMENSIONS
from evals.runner import EvalRun


@dataclass
class LevelStats:
    """单个难度层的统计。total/passed 数的是**运行次数**，不是任务数。"""

    total: int = 0
    passed: int = 0

    @property
    def pass_rate(self) -> float:
        return round(self.passed / self.total, 4) if self.total else 0.0


@dataclass
class ReliabilityStats:
    """稳定性指标。

    只有每条任务重复跑多次（`--repeat k`）时才有意义：

    · **Pass^k**（全过率）—— k 次**全部**成功的任务比例，回答"稳不稳"。
      回归测试该看这个：跑五次只成功一次的任务，不该算通过。
    · **Pass@k**（至少一次）—— k 次里**至少一次**成功的任务比例，回答"能不能做到"。
      适合探索性任务；用它做回归会掩盖不稳定性。

    两个数字差得越大，说明系统越不稳定。例如：
    单次成功率 60% 时，Pass@5 ≈ 99%，Pass^5 ≈ 7.8%——混用会严重误判。
    """

    tasks: int = 0  # 任务条数（不是运行次数）
    always_passed: int = 0  # 每次都通过的任务数
    ever_passed: int = 0  # 至少通过一次的任务数
    flaky: list[str] = field(default_factory=list)  # 时过时不过的任务

    @property
    def pass_pow_k(self) -> float:
        return round(self.always_passed / self.tasks, 4) if self.tasks else 0.0

    @property
    def pass_at_k(self) -> float:
        return round(self.ever_passed / self.tasks, 4) if self.tasks else 0.0


@dataclass
class EvalSummary:
    """一次评估的聚合指标。

    用 dataclass 而不是 dict：字段名和类型都能被类型检查器验证，
    渲染报告时不必再对 object 做类型断言。
    """

    model_id: str
    total: int  # 总运行次数 = 任务数 × repeat
    passed: int
    avg_latency_ms: float
    repeat: int = 1
    by_level: dict[str, LevelStats] = field(default_factory=dict)
    dimension_failures: dict[str, int] = field(default_factory=dict)
    vetoes: list[tuple[str, str]] = field(default_factory=list)
    error_codes: dict[str, int] = field(default_factory=dict)
    reliability: ReliabilityStats = field(default_factory=ReliabilityStats)

    @property
    def pass_rate(self) -> float:
        """单次通过率（Pass@1）：所有运行里成功的比例。"""
        return round(self.passed / self.total, 4) if self.total else 0.0

    def to_json(self) -> str:
        payload = asdict(self)
        payload["pass_rate"] = self.pass_rate
        payload["by_level"] = {
            level: {**asdict(stats), "pass_rate": stats.pass_rate}
            for level, stats in self.by_level.items()
        }
        payload["reliability"] = {
            **asdict(self.reliability),
            "pass_pow_k": self.reliability.pass_pow_k,
            "pass_at_k": self.reliability.pass_at_k,
        }
        return json.dumps(payload, ensure_ascii=False, indent=2)


def summarize(run: EvalRun) -> EvalSummary:
    """把评估结果聚合成可比较的指标。"""
    verdicts = run.verdicts
    total = len(verdicts)

    by_level: dict[str, LevelStats] = {}
    for verdict in verdicts:
        stats = by_level.setdefault(verdict.level, LevelStats())
        stats.total += 1
        stats.passed += int(verdict.passed)

    # 按 task_id 把多次运行归到一起，才能算稳定性指标
    runs_by_task: dict[str, list[bool]] = {}
    for verdict in verdicts:
        runs_by_task.setdefault(verdict.task_id, []).append(verdict.passed)

    reliability = ReliabilityStats(tasks=len(runs_by_task))
    for task_id, outcomes in runs_by_task.items():
        if all(outcomes):
            reliability.always_passed += 1
        if any(outcomes):
            reliability.ever_passed += 1
        # 有过有失就是 flaky——这类任务最值得警惕，单次评估会随机报喜或报忧
        if any(outcomes) and not all(outcomes):
            reliability.flaky.append(task_id)

    return EvalSummary(
        model_id=run.model_id,
        total=total,
        passed=sum(1 for v in verdicts if v.passed),
        avg_latency_ms=(
            round(sum(v.latency_ms for v in verdicts) / total, 1) if total else 0.0
        ),
        repeat=run.repeat,
        reliability=reliability,
        by_level=dict(sorted(by_level.items())),
        # 各维度的失败次数：直接告诉你该修哪一块
        dimension_failures=dict(
            Counter(
                dimension
                for verdict in verdicts
                for dimension in DIMENSIONS
                if verdict.scores.get(dimension) is False
            )
        ),
        # 否决项（幻觉类）单独统计，因为它比维度失败更严重
        vetoes=[(v.task_id, v.veto) for v in verdicts if v.veto],
        # 错误码分布：只统计**未通过**的运行。
        # 期望拒绝的任务成功拒绝时也带错误码，那属于正确行为，混进来会让人
        # 误以为出了一堆错——报告要能一眼看出"真正的问题有几个"。
        error_codes=dict(
            Counter(v.error_code for v in verdicts if v.error_code and not v.passed)
        ),
    )


def render_text(run: EvalRun) -> str:
    """渲染成终端可读的报告。"""
    stats = summarize(run)
    lines = [
        f"模型：{stats.model_id}",
        f"总体：{stats.passed}/{stats.total} 次运行通过"
        f"（{stats.pass_rate:.0%}），平均延迟 {stats.avg_latency_ms} ms",
    ]

    # 只跑一次时算不出稳定性，此时给出提示而不是一个误导性的数字
    if stats.repeat > 1:
        k = stats.repeat
        reliability = stats.reliability
        lines += [
            "",
            f"稳定性（每条任务跑 {k} 次，共 {reliability.tasks} 条）：",
            f"  Pass^{k}（{k} 次全过）：{reliability.always_passed}/{reliability.tasks}"
            f"  {reliability.pass_pow_k:.0%}   ← 回归测试看这个",
            f"  Pass@{k}（至少过一次）：{reliability.ever_passed}/{reliability.tasks}"
            f"  {reliability.pass_at_k:.0%}",
        ]
        if reliability.flaky:
            lines.append(f"  时过时不过的任务（{len(reliability.flaky)} 条）：")
            lines += [f"    · {task_id}" for task_id in sorted(reliability.flaky)]
    else:
        lines += ["", "（每条任务只跑了一次，算不出稳定性；用 --repeat 3 可得到 Pass^k）"]

    lines += ["", "按难度："]
    for level, counts in stats.by_level.items():
        lines.append(f"  {level}  {counts.passed}/{counts.total}  ({counts.pass_rate:.0%})")

    if stats.dimension_failures:
        lines += ["", "维度失败次数："]
        lines += [
            f"  {dimension}: {count}" for dimension, count in stats.dimension_failures.items()
        ]

    if stats.vetoes:
        lines += ["", "★ 否决项（幻觉类，最严重）："]
        lines += [f"  {task_id}: {reason}" for task_id, reason in stats.vetoes]

    if stats.error_codes:
        lines += ["", "错误码分布："]
        lines += [f"  {code}: {count}" for code, count in stats.error_codes.items()]

    failed = [v for v in run.verdicts if not v.passed]
    if failed:
        lines += ["", "未通过的任务："]
        for verdict in failed:
            reasons = "；".join(verdict.failures) or verdict.veto or "未知"
            lines.append(f"  [{verdict.level}] {verdict.task_id} — {reasons}")
            # 实际工具调用序列是定位 required_tools_not_used 的关键证据
            if used := verdict.diagnostics.get("used_tools"):
                lines.append(f"      实际调用：{used}")

    return "\n".join(lines)
