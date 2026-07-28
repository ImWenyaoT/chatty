"""评估执行器。

对应《深入理解 AI Agent》第 6.2 节"自动评估环境"。

教材列的评估环境五要素，在这里的落点：

    数据集          →  evals/dataset.py 的 ALL_TASKS
    环境状态        →  每条任务一个独立的临时 SQLite（可重置、互不污染）
    工具接口        →  复用 chatty 生产代码里的五个原子工具，不另造一套
    评分标准        →  evals/rubric.py
    执行协议        →  单轮请求-响应；Chatty 不是多轮对话，因此**不需要用户模拟器**

关于"不需要用户模拟器"：教材的 τ-bench 要模拟用户是因为客服场景是多轮对话，
需要渐进式透露信息。Chatty 的接口是一次 HTTP 请求进、一个推荐列表出，
用户意图在请求里一次性给全，所以照搬用户模拟器只会增加不确定性、降低可复现性。
**这是"严格对齐"和"照抄"的区别**——对齐的是方法论，不是具体组件。

关于评估对象（教材原话）：评估的对象不应只是模型，而应是**模型与 Harness 的组合体**。
所以这里跑的是完整的 `Recommender.recommend()`，不是绕开 Harness 直接调模型。
"""

from __future__ import annotations

import asyncio
import tempfile
from dataclasses import dataclass
from pathlib import Path

from agents import Model

from chatty.agent import RecommendationError, Recommender
from chatty.catalog import Catalog
from chatty.experiments import ExperimentMetrics
from evals.dataset import ALL_TASKS, EvalTask
from evals.rubric import TaskVerdict, grade


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
    """跑一条任务。

    每次都新建一个临时数据库，保证"可重置到相同初始状态"——
    这是教材对环境状态的硬要求，否则上一条任务的副作用会污染下一条。
    """
    with tempfile.TemporaryDirectory(prefix="chatty-eval-") as tmp:
        catalog = Catalog(data_dir, database_path=Path(tmp) / "eval.db")
        recommender = Recommender(catalog, ExperimentMetrics(), model=model)
        try:
            response = None
            error_code = None
            diagnostics: dict[str, object] = {}
            try:
                response = await recommender.recommend(task.to_request())
                latency_ms = response.total_latency_ms
            except RecommendationError as error:
                error_code = error.code
                diagnostics = error.diagnostics
                latency_ms = 0.0
            except Exception as error:  # noqa: BLE001
                # Recommender 内部已经把异常兜成 RecommendationError，能漏到这里的
                # 都是它管不到的（比如评估框架自己的 bug）。这类异常绝不能让整批评估中断——
                # 跑了半小时因为一条任务崩掉，前面的结果就全白费了。
                # 记成这一条任务的失败，附上异常类型便于事后定位。
                error_code = "eval_harness_error"
                diagnostics = {"exception": f"{type(error).__name__}: {error}"}
                latency_ms = 0.0

            return grade(
                task,
                response=response,
                error_code=error_code,
                forbidden_words=catalog.forbidden_words,
                latency_ms=latency_ms,
                diagnostics=diagnostics,
            )
        finally:
            await recommender.close()


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
