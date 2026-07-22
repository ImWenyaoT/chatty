"""Chatty SQLite 共享设施：Database 连接句柄与行读取契约。

规格：specs/stores.md §0。连接模型按 decisions.md §4.2：每 store 一个 Database 句柄
（check_same_thread=False、isolation_level=None 自管事务），写事务只能经 `.transaction()`
拿到（显式 BEGIN IMMEDIATE）。句柄自带写事务锁，锁身份由句柄自己决定，调用方不再
从路径、`PRAGMA database_list` 或字符串比较里重新推导：

- 文件库：按解析后的绝对路径查进程级注册表，同一文件的所有句柄共享同一把 RLock
  （`data/x.sqlite`、`./data/x.sqlite`、绝对路径三种写法必须命中同一把锁）。
- 非文件库（`:memory:`、`""` 匿名临时库）：彼此之间没有可共享的身份，每个句柄一把新锁。

需要共用一条连接的 store（KnowledgeStore 复用 CommerceStore 的）直接传句柄本身。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# 连接句柄（commerce/knowledge/artifacts/memory/support/traces 复用；decisions.md §4.2）
# ---------------------------------------------------------------------------

_Parameters = Sequence[Any] | Mapping[str, Any]

# 这些位置不指向文件：没有跨句柄可共享的身份，不进锁注册表。
_NON_FILE_LOCATIONS = frozenset({":memory:", ""})

_WRITE_LOCKS: dict[str, threading.RLock] = {}
_WRITE_LOCKS_GUARD = threading.Lock()


def _shared_write_lock(path: Path) -> threading.RLock:
    """按解析后的绝对路径返回进程级写事务锁（同一文件全进程共享一把 RLock）。"""
    key = str(path.resolve())
    with _WRITE_LOCKS_GUARD:
        lock = _WRITE_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _WRITE_LOCKS[key] = lock
        return lock


class Database:
    """一条 store 长连接 + 它自己的写事务锁。

    句柄负责三件调用方不该知道的事：连库前建父目录、每连接开启外键与 Row 工厂、
    以及"这个数据库归哪把锁管"。写事务只有 `.transaction()` 一个入口。
    """

    def __init__(self, database_path: str | Path) -> None:
        location = str(database_path)
        if location in _NON_FILE_LOCATIONS:
            # 非文件库：两个 `:memory:` 句柄是两个互不相干的库，不能共享一把锁。
            self._lock = threading.RLock()
        else:
            path = Path(location)
            path.parent.mkdir(parents=True, exist_ok=True)
            self._lock = _shared_write_lock(path)
        self._connection = sqlite3.connect(
            location, check_same_thread=False, isolation_level=None
        )
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys = ON")

    def execute(self, statement: str, parameters: _Parameters = ()) -> sqlite3.Cursor:
        return self._connection.execute(statement, parameters)

    def executemany(self, statement: str, parameters: Iterable[_Parameters]) -> sqlite3.Cursor:
        return self._connection.executemany(statement, parameters)

    def executescript(self, script: str) -> sqlite3.Cursor:
        # executescript 隐式提交并可能重置 PRAGMA；外键属 per-connection，建表后重申。
        cursor = self._connection.executescript(script)
        self._connection.execute("PRAGMA foreign_keys = ON")
        return cursor

    @contextmanager
    def transaction(self) -> Iterator[Database]:
        """BEGIN IMMEDIATE → 写语句 → COMMIT；异常时 ROLLBACK 并重抛原异常。

        COMMIT 在 try 内：COMMIT 自身失败也要回滚，绝不把连接留在事务中。锁串行化
        同一数据库上的写事务；RLock 允许同一线程内嵌套（重入即同一事务）。
        """
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                yield self
                self._connection.execute("COMMIT")
            except BaseException:
                if self._connection.in_transaction:
                    self._connection.execute("ROLLBACK")
                raise

    def close(self) -> None:
        self._connection.close()


# ---------------------------------------------------------------------------
# 行读取契约（specs/stores.md §0.2：fail-fast，不做静默转换）
# ---------------------------------------------------------------------------


def text(row: sqlite3.Row, key: str) -> str:
    value = row[key]
    if not isinstance(value, str):
        raise ValueError(f"invalid SQLite text: {key}")
    return value


def integer(row: sqlite3.Row, key: str) -> int:
    value = row[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"invalid SQLite integer: {key}")
    return value


def nullable_text(row: sqlite3.Row, key: str) -> str | None:
    value = row[key]
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"invalid SQLite text: {key}")
    return value


def string_array(row: sqlite3.Row, key: str) -> list[str]:
    parsed = json.loads(text(row, key))
    if not isinstance(parsed, list) or any(not isinstance(item, str) for item in parsed):
        raise ValueError(f"invalid SQLite string array: {key}")
    return parsed
