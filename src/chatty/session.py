"""会话历史：SDK SQLiteSession 的表名、生命周期与属主校验（specs/runtime-eval.md §5.7）。

会话历史是唯一一个既有存储又有归属规则的持久化概念，本模块是它的唯一入口：

- **表名**：`chatty_sessions` / `chatty_messages` 只在这里出现，SDK 自己建表；
- **连接生命周期**：`open()` 是上下文管理器，SQLiteSession 一律随块结束关闭，调用方
  不需要记得 `try/finally`；
- **属主规则**：`claim()` / `require_owner()` 把 memory 里的会话归属表包成 run 循环的
  失败词汇（RunFailure），HTTP 层按 code 映射状态码；
- **SDK 原生格式，不做转换**：`messages()` 原样返回存储态 JSON 对象。

本模块不持有长连接（SQLiteSession 每次调用自开自关），因此没有 close()。它也完全
不涉及 Model / Agent / tools：读会话历史不需要 LLM 配置。
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from agents import SQLiteSession

from chatty.harness import RunFailure
from chatty.memory import MemoryStore, SessionCustomerMismatchError, SessionNotFoundError

SESSIONS_TABLE = "chatty_sessions"
MESSAGES_TABLE = "chatty_messages"


class SessionHistory:
    """一个数据库文件上的会话历史（SDK SQLiteSession）+ 会话归属校验。"""

    def __init__(self, database_path: str | Path, memory: MemoryStore) -> None:
        self.database_path = Path(database_path)
        self._memory = memory

    @contextmanager
    def open(self, session_id: str) -> Iterator[SQLiteSession]:
        """打开一次 SDK 会话；退出块时必定关闭（表名与 db 路径由本模块决定）。"""
        session = SQLiteSession(
            session_id,
            db_path=self.database_path,
            sessions_table=SESSIONS_TABLE,
            messages_table=MESSAGES_TABLE,
        )
        try:
            yield session
        finally:
            session.close()

    def claim(self, *, session_id: str, customer_id: str) -> None:
        """首次绑定即"发放"该会话，之后归属不可变。

        与 `require_owner` 不同，这里**不**把冲突翻译成 RunFailure：run 循环只在新
        会话 uuid 或已通过校验的会话上调用它，冲突实际不可达，万一发生要裸抛成 500。
        """
        self._memory.bind_session(session_id=session_id, customer_id=customer_id)

    def require_owner(self, *, session_id: str, customer_id: str) -> None:
        """属主校验；失败以 RunFailure 对外（HTTP 层按 code 决定 404/409）。"""
        try:
            self._memory.require_session(session_id=session_id, customer_id=customer_id)
        except SessionNotFoundError as error:
            raise RunFailure("session_not_found") from error
        except SessionCustomerMismatchError as error:
            raise RunFailure("session_customer_mismatch") from error

    async def messages(self, *, session_id: str, customer_id: str) -> list[dict[str, Any]]:
        """属主校验后返回存储态消息 JSON 列表（SDK 原生格式，不做转换）。"""
        self.require_owner(session_id=session_id, customer_id=customer_id)
        with self.open(session_id) as session:
            items = await session.get_items()
        return [dict(item) for item in items]
