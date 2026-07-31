"""跑一次会话并把结果收成可判定的形状。

单轮和多轮此前各有一份「建环境 → 建 Recommender → 跑 → 把异常变成一条记录 →
关掉」的实现，只有底层的 `_run_turn` 是共享的。两份之间的不变量没有传递：
多轮那份丢了环境隔离、丢了 error_code 分层、丢了模型注入口，于是它既跑不了
离线测试，也在共享 Catalog 上踩了连接提前关闭的坑。

现在只有这一份。差异（单轮 vs 多轮、拿什么裁决）留在调用方：
`run_session` 只负责环境、注入、异常分码和延迟，裁决是另一件事。
"""

from __future__ import annotations

import tempfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

from agents import Model

from chatty.agent import RecommendationError, Recommender
from chatty.catalog import Catalog
from chatty.models import ClarifyReply, RecommendationResponse

# 拿到一个 Recommender，跑完一次会话。调用方在这里决定单轮还是多轮。
Session = Callable[[Recommender], Awaitable[RecommendationResponse | ClarifyReply]]


@dataclass
class SessionOutcome:
    """一次会话跑完之后可判定的东西。

    reply 与 error_code 互斥：要么跑通了（reply 有值），要么失败了（error_code 有值）。
    """

    reply: RecommendationResponse | ClarifyReply | None = None
    error_code: str | None = None
    diagnostics: dict[str, object] = field(default_factory=dict)
    latency_ms: float = 0.0
    forbidden_words: list[str] = field(default_factory=list)


async def run_session(
    session: Session,
    *,
    model: Model | None = None,
    data_dir: Path | None = None,
) -> SessionOutcome:
    """在一个干净的临时库上跑一次会话。

    每次都新建临时数据库，保证"可重置到相同初始状态"——这是评估环境的硬要求，
    否则上一条任务的副作用会污染下一条。
    """
    with tempfile.TemporaryDirectory(prefix="chatty-eval-") as tmp:
        catalog = Catalog(data_dir, database_path=Path(tmp) / "eval.db")
        recommender = Recommender(catalog, model=model)
        try:
            outcome = SessionOutcome(forbidden_words=catalog.forbidden_words)
            try:
                reply = await session(recommender)
                outcome.reply = reply
                outcome.latency_ms = reply.total_latency_ms
            # ↓↓↓ 两层异常，从"已知业务失败"到"完全没预料到" ↓↓↓
            except RecommendationError as error:
                outcome.error_code = error.code
                outcome.diagnostics = error.diagnostics
            except Exception as error:  # noqa: BLE001
                # Recommender 内部已经把异常兜成 RecommendationError，能漏到这里的
                # 都是它管不到的（比如评估框架自己的 bug）。这类异常绝不能让整批评估
                # 中断——跑了半小时因为一条任务崩掉，前面的结果就全白费了。
                outcome.error_code = "eval_harness_error"
                outcome.diagnostics = {"exception": f"{type(error).__name__}: {error}"}
            return outcome
        finally:
            await recommender.close()
            catalog.close()
