"""chatty.sqlite 直接测试：句柄的写事务锁身份、事务错误模式与行读取契约。

这三条不变量此前只被各 store 间接触及：锁身份（同一文件的不同写法必须命中同一把
RLock，store.py 拆分后这是跨 store 的承重保证）、`transaction()` 的回滚重抛（含
COMMIT 自身失败）、以及行读取契约的 fail-fast 口径。
"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Any, cast

import pytest

from chatty.artifacts import ArtifactStore
from chatty.commerce import CommerceStore
from chatty.memory import MemoryStore
from chatty.sqlite import Database, integer, nullable_text, string_array, text


@pytest.fixture
def database(tmp_path: Path) -> Database:
    handle = Database(tmp_path / "chatty.sqlite")
    handle.execute("CREATE TABLE t (v TEXT PRIMARY KEY)")
    return handle


def fake_row(**columns: Any) -> sqlite3.Row:
    """行读取契约只用 row[key]；bool 这种 SQLite 永远不会产出的值只能靠映射桩喂进去。"""
    return cast(sqlite3.Row, columns)


def one_row(handle: Database, statement: str) -> sqlite3.Row:
    row = handle.execute(statement).fetchone()
    assert row is not None
    return cast(sqlite3.Row, row)


class _CommitFailingConnection:
    """只在 COMMIT 上失败的连接桩。

    真实的 COMMIT 失败（例如别的连接持有 SHARED 锁导致 SQLITE_BUSY）要等满 busy
    timeout 才会抛，做成确定性快测不现实；这里直接让 COMMIT 抛，专测语句顺序。
    """

    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def execute(self, statement: str, parameters: Any = ()) -> sqlite3.Cursor:
        if statement == "COMMIT":
            raise sqlite3.OperationalError("commit failed")
        return self._connection.execute(statement, parameters)

    @property
    def in_transaction(self) -> bool:
        return self._connection.in_transaction


class TestWriteLockIdentity:
    def test_path_spellings_of_one_file_share_one_lock(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.chdir(tmp_path)
        (tmp_path / "data").mkdir()
        relative = Database("data/chatty.sqlite")
        dotted = Database("./data/chatty.sqlite")
        absolute = Database(tmp_path / "data" / "chatty.sqlite")
        indirect = Database(tmp_path / "data" / ".." / "data" / "chatty.sqlite")
        try:
            assert relative._lock is dotted._lock
            assert relative._lock is absolute._lock
            assert relative._lock is indirect._lock
        finally:
            for handle in (relative, dotted, absolute, indirect):
                handle.close()

    def test_different_files_get_different_locks(self, tmp_path: Path) -> None:
        first = Database(tmp_path / "a.sqlite")
        second = Database(tmp_path / "b.sqlite")
        try:
            assert first._lock is not second._lock
        finally:
            first.close()
            second.close()

    def test_stores_on_one_file_share_the_lock(self, tmp_path: Path) -> None:
        """跨 store 的承重保证：commerce/artifacts/memory 同文件即同一把写锁。"""
        database_path = tmp_path / "chatty.sqlite"
        commerce = CommerceStore(database_path)
        artifacts = ArtifactStore(database_path)
        memory = MemoryStore(str(database_path))
        try:
            assert commerce.database._lock is artifacts._database._lock
            assert commerce.database._lock is memory.database._lock
        finally:
            commerce.close()
            artifacts.close()
            memory.close()

    def test_knowledge_shares_the_commerce_handle(self, tmp_path: Path) -> None:
        """KnowledgeStore 不再从连接反推数据库文件：直接拿到同一个句柄。"""
        from chatty.knowledge import KnowledgeStore

        commerce = CommerceStore(tmp_path / "chatty.sqlite")
        try:
            knowledge = KnowledgeStore(commerce.database)
            assert knowledge.database is commerce.database
        finally:
            commerce.close()

    def test_memory_databases_never_share_a_lock(self, tmp_path: Path) -> None:
        """`:memory:` 不是文件身份：两个内存库各自一把新锁，也不和 cwd 下的假路径混用。"""
        first = Database(":memory:")
        second = Database(":memory:")
        file_backed = Database(tmp_path / ":memory:")
        try:
            assert first._lock is not second._lock
            assert first._lock is not file_backed._lock
        finally:
            for handle in (first, second, file_backed):
                handle.close()

    def test_memory_stores_do_not_serialize_against_each_other(self) -> None:
        first = ArtifactStore(":memory:")
        second = ArtifactStore(":memory:")
        try:
            assert first._database._lock is not second._database._lock
        finally:
            first.close()
            second.close()


class TestTransaction:
    def test_commits_on_success(self, database: Database) -> None:
        with database.transaction() as connection:
            connection.execute("INSERT INTO t (v) VALUES ('a')")
        assert database.execute("SELECT COUNT(*) AS n FROM t").fetchone()["n"] == 1
        assert database._connection.in_transaction is False

    def test_yields_the_same_handle(self, database: Database) -> None:
        with database.transaction() as connection:
            assert connection is database

    def test_rolls_back_and_reraises(self, database: Database) -> None:
        database.execute("INSERT INTO t (v) VALUES ('a')")
        with pytest.raises(sqlite3.IntegrityError), database.transaction() as connection:
            connection.execute("INSERT INTO t (v) VALUES ('b')")
            connection.execute("INSERT INTO t (v) VALUES ('a')")  # PK 冲突
        assert [row["v"] for row in database.execute("SELECT v FROM t")] == ["a"]
        assert database._connection.in_transaction is False

    def test_rollback_leaves_the_handle_usable(self, database: Database) -> None:
        with pytest.raises(RuntimeError), database.transaction() as connection:
            connection.execute("INSERT INTO t (v) VALUES ('a')")
            raise RuntimeError("caller blew up")
        assert database.execute("SELECT COUNT(*) AS n FROM t").fetchone()["n"] == 0
        with database.transaction() as connection:
            connection.execute("INSERT INTO t (v) VALUES ('b')")
        assert [row["v"] for row in database.execute("SELECT v FROM t")] == ["b"]

    def test_commit_failure_rolls_back_and_reraises(self, database: Database) -> None:
        """COMMIT 在 try 内：COMMIT 自己失败也必须回滚，绝不把连接留在事务里。"""
        real = database._connection
        database._connection = cast(sqlite3.Connection, _CommitFailingConnection(real))
        try:
            with (
                pytest.raises(sqlite3.OperationalError, match="commit failed"),
                database.transaction() as connection,
            ):
                connection.execute("INSERT INTO t (v) VALUES ('a')")
        finally:
            database._connection = real
        assert real.in_transaction is False
        assert database.execute("SELECT COUNT(*) AS n FROM t").fetchone()["n"] == 0
        # 连接没被留在开着的事务里：下一次写事务照常提交。
        with database.transaction() as connection:
            connection.execute("INSERT INTO t (v) VALUES ('b')")
        assert [row["v"] for row in database.execute("SELECT v FROM t")] == ["b"]

    def test_reentrant_on_one_thread(self, database: Database) -> None:
        """锁是 RLock：同线程重入不死锁（嵌套 BEGIN 由 SQLite 自己拒绝）。"""
        with database.transaction():
            assert database._lock.acquire(blocking=False)
            database._lock.release()

    def test_serializes_writes_across_handles_on_one_file(self, tmp_path: Path) -> None:
        database_path = tmp_path / "chatty.sqlite"
        first = Database(database_path)
        first.execute("CREATE TABLE t (v TEXT)")
        second = Database(database_path)
        entered = threading.Event()
        finished = threading.Event()

        def write_from_second() -> None:
            with second.transaction() as connection:
                connection.execute("INSERT INTO t (v) VALUES ('second')")
            finished.set()

        worker = threading.Thread(target=write_from_second)
        try:
            with first.transaction() as connection:
                connection.execute("INSERT INTO t (v) VALUES ('first')")
                worker.start()
                entered.set()
                # 第二个句柄必须在锁上等待，而不是撞 SQLITE_BUSY。
                assert not finished.wait(timeout=0.2)
            assert finished.wait(timeout=5)
        finally:
            worker.join(timeout=5)
            first.close()
            second.close()
        assert entered.is_set()


class TestOpenedConnection:
    def test_creates_parent_directories(self, tmp_path: Path) -> None:
        handle = Database(tmp_path / "nested" / "deeper" / "chatty.sqlite")
        handle.close()
        assert (tmp_path / "nested" / "deeper" / "chatty.sqlite").exists()

    def test_rows_are_addressable_by_column_name(self, database: Database) -> None:
        assert one_row(database, "SELECT 1 AS n")["n"] == 1

    def test_foreign_keys_stay_on_after_executescript(self, tmp_path: Path) -> None:
        handle = Database(tmp_path / "chatty.sqlite")
        handle.executescript(
            "CREATE TABLE parent (id TEXT PRIMARY KEY);"
            "CREATE TABLE child (parent_id TEXT REFERENCES parent(id));"
        )
        try:
            with pytest.raises(sqlite3.IntegrityError):
                handle.execute("INSERT INTO child (parent_id) VALUES ('missing')")
        finally:
            handle.close()


class TestRowHelpers:
    def test_text_accepts_text(self, database: Database) -> None:
        assert text(one_row(database, "SELECT 'x' AS v"), "v") == "x"

    @pytest.mark.parametrize("statement", ["SELECT 1 AS v", "SELECT NULL AS v", "SELECT 1.5 AS v"])
    def test_text_rejects_everything_else(self, database: Database, statement: str) -> None:
        with pytest.raises(ValueError, match="invalid SQLite text: v"):
            text(one_row(database, statement), "v")

    def test_integer_accepts_integers(self, database: Database) -> None:
        assert integer(one_row(database, "SELECT 7 AS v"), "v") == 7

    @pytest.mark.parametrize(
        "statement", ["SELECT 'x' AS v", "SELECT NULL AS v", "SELECT 1.5 AS v"]
    )
    def test_integer_rejects_everything_else(self, database: Database, statement: str) -> None:
        with pytest.raises(ValueError, match="invalid SQLite integer: v"):
            integer(one_row(database, statement), "v")

    @pytest.mark.parametrize("value", [True, False])
    def test_integer_rejects_bool(self, value: bool) -> None:
        # isinstance(True, int) 为真，所以这条守卫必须显式写出来，也必须被测到。
        with pytest.raises(ValueError, match="invalid SQLite integer: v"):
            integer(fake_row(v=value), "v")

    def test_nullable_text_maps_null_to_none(self, database: Database) -> None:
        assert nullable_text(one_row(database, "SELECT NULL AS v"), "v") is None
        assert nullable_text(one_row(database, "SELECT 'x' AS v"), "v") == "x"

    def test_nullable_text_rejects_non_text(self, database: Database) -> None:
        with pytest.raises(ValueError, match="invalid SQLite text: v"):
            nullable_text(one_row(database, "SELECT 1 AS v"), "v")

    def test_string_array_parses_json_arrays(self, database: Database) -> None:
        assert string_array(one_row(database, """SELECT '["a","b"]' AS v"""), "v") == ["a", "b"]
        assert string_array(one_row(database, "SELECT '[]' AS v"), "v") == []

    @pytest.mark.parametrize(
        "stored",
        ['{"a":1}', '"a"', "[1]", '["a",2]', "[null]"],
    )
    def test_string_array_rejects_non_string_arrays(
        self, database: Database, stored: str
    ) -> None:
        row = one_row(database, f"SELECT '{stored}' AS v")
        with pytest.raises(ValueError, match="invalid SQLite string array: v"):
            string_array(row, "v")

    def test_string_array_rejects_invalid_json(self, database: Database) -> None:
        # json.JSONDecodeError 是 ValueError 的子类：同样是 fail-fast，不静默返回空表。
        with pytest.raises(ValueError):
            string_array(one_row(database, "SELECT 'not-json' AS v"), "v")

    def test_string_array_rejects_non_text_column(self, database: Database) -> None:
        with pytest.raises(ValueError, match="invalid SQLite text: v"):
            string_array(one_row(database, "SELECT 1 AS v"), "v")
