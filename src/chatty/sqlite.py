"""Chatty SQLite 共享设施：连接、写事务锁与行读取契约。

规格：specs/stores.md §0。连接模型按 decisions.md §4.2：
每 store 一条长连接（check_same_thread=False、isolation_level=None 自管事务）、
显式 BEGIN IMMEDIATE 写事务、每个数据库文件一把进程级 threading.RLock 串行化写事务。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

# ---------------------------------------------------------------------------
# 共享连接设施（commerce/knowledge/artifacts 复用；decisions.md §4.2）
# ---------------------------------------------------------------------------

_DATABASE_LOCKS: dict[str, threading.RLock] = {}
_DATABASE_LOCKS_GUARD = threading.Lock()


def database_write_lock(database_path: str | Path) -> threading.RLock:
    """按数据库文件返回进程级写事务锁（同一文件全进程共享一把 RLock）。"""
    key = str(Path(database_path).resolve())
    with _DATABASE_LOCKS_GUARD:
        lock = _DATABASE_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _DATABASE_LOCKS[key] = lock
        return lock


def open_connection(database_path: str | Path) -> sqlite3.Connection:
    """打开 store 长连接：mkdir 父目录 + Row 工厂 + 每连接开启外键 + 自管事务。"""
    path = Path(database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


@contextmanager
def write_transaction(
    connection: sqlite3.Connection, lock: threading.RLock
) -> Iterator[sqlite3.Connection]:
    """BEGIN IMMEDIATE → 操作 → COMMIT；异常 ROLLBACK 并重抛。锁串行化同文件写事务。"""
    with lock:
        connection.execute("BEGIN IMMEDIATE")
        try:
            yield connection
            connection.execute("COMMIT")
        except BaseException:
            connection.execute("ROLLBACK")
            raise


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
