"""评分标准（Rubric）。

客服退款类场景常用四个维度：操作正确性、政策合规性、信息完整性、
幻觉检测（否决项）。映射到电商推荐场景：

    客服退款场景            →   Chatty（电商推荐）
    ─────────────────────────────────────────────────────
    操作正确性              →   推荐的商品真实存在且有货
    政策合规性              →   价格在用户区间内、数量与类目符合请求
    信息完整性              →   理由与文案都给了且非空洞
    幻觉检测（否决项）      →   禁词、越界商品

**为什么没有"流程合规性"这一维**：τ-bench 需要事后分析工具调用序列，
因为它评的 Agent 没有运行时守卫。Chatty 不同——工具调用是否合规是
Harness 的**运行时前置条件**（`tools.validate_tool_sequence` 不通过就直接抛错），
所以"成功返回"本身就蕴含了"五个工具都调用过且依赖顺序正确"，再单独评一维恒为真、没有区分度；
而违规的情况会以 `required_tools_not_used` 错误码出现，已被拒绝路径覆盖。
这正是"守卫"和"评分"的区别：守卫让违规无法发生，评分只是记录违规发生了。

**否决项**与质量正交——一个流畅、详尽的回答如果包含
虚假事实，危害远大于一个简短但准确的回答。所以否决项不参与加权平均，
一旦触发，整条任务直接判负。

**二元奖励**：τ-bench 在任务层面只给 0 或 1，全部检查通过才算成功。
这里两个都记：`passed` 用于统计成功率，`scores` 用于诊断到底哪一维弱。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from chatty.models import RecommendationResponse
from evals.dataset import EvalTask, Expect

# 评分维度的显示名，报告里按这个顺序输出
DIMENSIONS = (
    "操作正确性",
    "政策合规性",
    "信息完整性",
)


@dataclass
class TaskVerdict:
    """一条任务的评分结果。"""

    task_id: str
    level: str
    passed: bool  # 二元奖励：所有维度达标且未触发否决项
    scores: dict[str, bool] = field(default_factory=dict)  # 分维度是否达标
    veto: str | None = None  # 触发的否决项原因（幻觉类）
    failures: list[str] = field(default_factory=list)  # 人读的失败说明
    error_code: str | None = None  # 实际抛出的错误码（如果失败）
    diagnostics: dict[str, object] = field(default_factory=dict)  # 根因定位用的结构化上下文
    latency_ms: float = 0.0


def grade_refusal(
    task: EvalTask,
    error_code: str | None,
    latency_ms: float,
) -> TaskVerdict:
    """给"期望拒绝"的任务打分。

    Agent 拒绝了才算对；返回了推荐反而是错的（说明它在没有依据的情况下硬编）。
    """
    verdict = TaskVerdict(
        task_id=task.task_id, level=str(task.level), passed=False, latency_ms=latency_ms
    )

    if error_code is None:
        # 本该拒绝却成功返回了——这是最严重的失败，按幻觉否决处理。
        verdict.veto = "本应拒绝的请求却返回了推荐"
        verdict.failures.append("期望 refuse，实际 succeed")
        return verdict

    verdict.error_code = error_code
    # 允许的错误码留空表示"任何失败都算对"；否则要求落在预期集合内。
    if task.allowed_error_codes and error_code not in task.allowed_error_codes:
        verdict.failures.append(
            f"拒绝原因不符合预期：得到 {error_code}，期望属于 {sorted(task.allowed_error_codes)}"
        )
        return verdict

    verdict.passed = True
    return verdict


def grade_success(
    task: EvalTask,
    response: RecommendationResponse,
    forbidden_words: list[str],
    latency_ms: float,
) -> TaskVerdict:
    """给"期望成功"的任务打分，逐维度检查。"""
    verdict = TaskVerdict(
        task_id=task.task_id, level=str(task.level), passed=False, latency_ms=latency_ms
    )
    products = response.products

    # ── 否决项一：禁词。文案里出现原词即判负（sanitize 应该已经替换掉了）──
    for item in products:
        for word in forbidden_words:
            if word in item.reason or word in item.marketing_copy:
                verdict.veto = f"文案出现禁词「{word}」"
                verdict.failures.append(f"{item.product_id} 的文案未被禁词过滤")
                return verdict

    # ── 否决项二：越界商品。出现了任务明令禁止的商品（售罄、超预算等）──
    banned_hits = [
        item.product_id for item in products if item.product_id in task.banned_product_ids
    ]
    if banned_hits:
        verdict.veto = f"推荐了被禁止的商品 {banned_hits}"
        verdict.failures.append("说明证据校验或 finalize 过滤失效")
        return verdict

    # ── 维度一：操作正确性 —— 商品真实存在（有名字）且库存为正 ──
    operation_ok = bool(products) and all(item.name and item.stock > 0 for item in products)
    verdict.scores["操作正确性"] = operation_ok
    if not operation_ok:
        verdict.failures.append("存在无名或零库存商品")

    # ── 维度二：政策合规性 —— 价格在区间内、数量不超上限、类目符合要求 ──
    policy_failures: list[str] = []
    if len(products) > task.num_items:
        policy_failures.append(f"返回 {len(products)} 条，超过请求的 {task.num_items} 条")
    if task.max_price_cents is not None:
        over = [i.product_id for i in products if i.price_cents > task.max_price_cents]
        if over:
            policy_failures.append(f"{over} 超出预算上限")
    if task.min_price_cents is not None:
        under = [i.product_id for i in products if i.price_cents < task.min_price_cents]
        if under:
            policy_failures.append(f"{under} 低于预算下限")
    if task.required_categories:
        wrong = [i.product_id for i in products if i.category not in task.required_categories]
        if wrong:
            policy_failures.append(f"{wrong} 不属于请求的类目")
    verdict.scores["政策合规性"] = not policy_failures
    verdict.failures.extend(policy_failures)

    # ── 维度三：信息完整性 —— 理由和文案都要有实质内容，不能是一两个字敷衍 ──
    info_ok = all(
        len(item.reason.strip()) >= 8 and len(item.marketing_copy.strip()) >= 8
        for item in products
    )
    verdict.scores["信息完整性"] = info_ok
    if not info_ok:
        verdict.failures.append("存在过短的推荐理由或营销文案")

    # 二元奖励：所有维度都达标才算通过
    verdict.passed = all(verdict.scores.values())
    return verdict


def grade(
    task: EvalTask,
    *,
    response: RecommendationResponse | None,
    error_code: str | None,
    forbidden_words: list[str],
    latency_ms: float,
    diagnostics: dict[str, object] | None = None,
) -> TaskVerdict:
    """统一入口：按任务的期望走对应的评分路径。"""
    if task.expect is Expect.REFUSE:
        verdict = grade_refusal(task, error_code, latency_ms)
        verdict.diagnostics = diagnostics or {}
        return verdict

    if response is None:
        # 期望成功却失败了
        verdict = TaskVerdict(
            task_id=task.task_id,
            level=str(task.level),
            passed=False,
            error_code=error_code,
            diagnostics=diagnostics or {},
            latency_ms=latency_ms,
        )
        verdict.failures.append(f"期望 succeed，实际失败于 {error_code}")
        return verdict

    return grade_success(task, response, forbidden_words, latency_ms)
