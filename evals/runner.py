"""单轮评估执行器。

评估环境的五个要素在这里的落点：

    数据集          →  evals/dataset.py 的 ALL_TASKS
    环境状态        →  evals/session.py，每条任务一个独立的临时 SQLite
    工具接口        →  复用 chatty 生产代码里的五个原子工具，不另造一套
    评分标准        →  evals/rubric.py
    执行协议        →  单轮请求-响应，需求在请求里一次性给全

单轮**刻意不用用户模拟器**：需求既然一次给全，多引一次模型调用只会增加不确定性、
降低可复现性。信息渐进透露的那条路径由 evals/multiturn.py 覆盖，它有自己的
用户模拟器和自己的裁决——两者共用 evals/session.py 的执行器，但数据集与评分不合并。
**这是"严格对齐"和"照抄"的区别**——对齐的是方法论，不是具体组件。

评估的对象不应只是模型，而应是**模型与 Harness 的组合体**。
所以这里跑的是完整的 `Recommender.recommend()`，不是绕开 Harness 直接调模型。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

from agents import Model

from chatty.models import RecommendationResponse
from evals.dataset import ALL_TASKS, EvalTask
from evals.rubric import TaskVerdict, grade
from evals.session import run_session


@dataclass
class EvalRun:
    """一次完整评估的结果。

    verdicts 是平铺的：如果每条任务跑了 3 次，18 条任务就有 54 条记录，
    同一条任务的多次结果靠 task_id 关联。
    """

    model_id: str
    verdicts: list[TaskVerdict]
    repeat: int = 1  # 每条任务重复跑了几次


async def run_task(
    task: EvalTask,
    *,
    model: Model | None = None,
    data_dir: Path | None = None,
) -> TaskVerdict:
    """跑一条单轮任务：会话执行交给 run_session，这里只管把结果送去裁决。"""
    outcome = await run_session(
        lambda recommender: recommender.recommend(task.to_request()),
        model=model,
        data_dir=data_dir,
    )
    # 单轮的期望就是一个推荐结果；respond 那条多轮路径不会走到这里。
    response = outcome.reply if isinstance(outcome.reply, RecommendationResponse) else None
    return grade(
        task,
        response=response,
        error_code=outcome.error_code,
        forbidden_words=outcome.forbidden_words,
        latency_ms=outcome.latency_ms,
        diagnostics=outcome.diagnostics,
    )


async def run_suite(
    tasks: tuple[EvalTask, ...] = ALL_TASKS,
    *,
    model: Model | None = None,
    model_id: str = "unknown",
    data_dir: Path | None = None,
    concurrency: int = 2,
    repeat: int = 1,
) -> EvalRun:
    """跑整个任务集。

    repeat 是每条任务重复跑几次。真实模型是概率性的，同一条任务
    这次过下次不过很常见，跑一次只能得到一个抖动很大的数字。
    重复多次才能算出 Pass^k（见 report.py），也就是"稳定不稳定"。

    并发度默认给 2：真实模型调用有速率限制，跑太猛容易触发限流，
    而限流导致的失败会被误判成 Agent 能力问题，污染评估结论。
    """
    semaphore = asyncio.Semaphore(concurrency)

    async def guarded(task: EvalTask) -> TaskVerdict:
        async with semaphore:
            return await run_task(task, model=model, data_dir=data_dir)

    # 同一条任务重复 repeat 次，结果平铺进一个列表；
    # 统计时按 task_id 分组，就能知道每条任务各跑了几次、过了几次。
    jobs = [guarded(task) for task in tasks for _ in range(repeat)]
    verdicts = await asyncio.gather(*jobs)
    return EvalRun(model_id=model_id, verdicts=list(verdicts), repeat=repeat)
