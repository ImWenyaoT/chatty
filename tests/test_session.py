"""SessionHistory 测试：表名、SQLiteSession 生命周期、属主规则、原生格式。

这些用例完全不构建 Model / Agent / run 模块——会话历史是纯存储概念。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from chatty.harness import RunFailure
from chatty.runtime import NativeRuntime
from chatty.session import MESSAGES_TABLE, SESSIONS_TABLE, SessionHistory


@pytest.fixture
def runtime(tmp_path: Path):
    native_runtime = NativeRuntime(tmp_path / "chatty.sqlite")
    yield native_runtime
    native_runtime.close()


def test_runtime_exposes_session_history(runtime: NativeRuntime) -> None:
    assert isinstance(runtime.sessions, SessionHistory)
    assert runtime.sessions.database_path == runtime.database_path


async def test_messages_returns_sdk_native_items(runtime: NativeRuntime) -> None:
    runtime.memory.bind_session(session_id="session_1", customer_id="customer-1")
    with runtime.sessions.open("session_1") as session:
        await session.add_items(
            [
                {"role": "user", "content": "第一句"},
                {"role": "assistant", "content": "收到。"},
            ]
        )
    messages = await runtime.sessions.messages(
        session_id="session_1", customer_id="customer-1"
    )
    # SDK 原生格式，不做转换。
    assert messages == [
        {"role": "user", "content": "第一句"},
        {"role": "assistant", "content": "收到。"},
    ]


async def test_messages_rejects_unknown_and_foreign_sessions(runtime: NativeRuntime) -> None:
    with pytest.raises(RunFailure) as exc_info:
        await runtime.sessions.messages(session_id="never-issued", customer_id="customer-1")
    assert exc_info.value.code == "session_not_found"
    assert exc_info.value.trace_id is None
    runtime.memory.bind_session(session_id="session_2", customer_id="customer-2")
    with pytest.raises(RunFailure) as exc_info:
        await runtime.sessions.messages(session_id="session_2", customer_id="customer-1")
    assert exc_info.value.code == "session_customer_mismatch"


def test_require_owner_accepts_claimed_session(runtime: NativeRuntime) -> None:
    runtime.sessions.claim(session_id="session_3", customer_id="customer-1")
    runtime.sessions.require_owner(session_id="session_3", customer_id="customer-1")
    # 归属不可变：重复 claim 同一客户是幂等的。
    runtime.sessions.claim(session_id="session_3", customer_id="customer-1")
    with pytest.raises(RunFailure) as exc_info:
        runtime.sessions.require_owner(session_id="session_3", customer_id="customer-2")
    assert exc_info.value.code == "session_customer_mismatch"


async def test_open_closes_session_even_on_error(runtime: NativeRuntime) -> None:
    opened = None
    with pytest.raises(RuntimeError, match="boom"), runtime.sessions.open("session_4") as session:
        opened = session
        raise RuntimeError("boom")
    assert opened is not None
    # 已关闭：SDK 的 close() 置位并释放连接池与文件锁。
    assert opened._closed is True


async def test_messages_land_in_chatty_tables(runtime: NativeRuntime) -> None:
    runtime.memory.bind_session(session_id="session_5", customer_id="customer-1")
    with runtime.sessions.open("session_5") as session:
        await session.add_items([{"role": "user", "content": "落表检查"}])
    # 表名只由 session 模块决定；用 runtime 已有的句柄回读。
    rows = runtime.memory.database.execute(
        f"SELECT session_id FROM {SESSIONS_TABLE}"  # noqa: S608 - 常量表名
    ).fetchall()
    assert [row[0] for row in rows] == ["session_5"]
    count = runtime.memory.database.execute(
        f"SELECT COUNT(*) FROM {MESSAGES_TABLE} WHERE session_id = ?",  # noqa: S608
        ("session_5",),
    ).fetchone()
    assert count[0] == 1
