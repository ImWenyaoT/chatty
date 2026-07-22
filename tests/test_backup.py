"""backup_database / CLI 契约测试：在线备份、页数、路径校验、JSON 输出。"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from chatty.backup import backup_database, main
from chatty.commerce import CommerceStore


def make_source(path: Path) -> None:
    store = CommerceStore(path)
    store.close()


def page_count(path: Path) -> int:
    connection = sqlite3.connect(path)
    try:
        return int(connection.execute("PRAGMA page_count").fetchone()[0])
    finally:
        connection.close()


class TestBackupDatabase:
    def test_copies_database_and_returns_page_count(self, tmp_path: Path) -> None:
        source = tmp_path / "chatty.sqlite"
        output = tmp_path / "backup.sqlite"
        make_source(source)
        pages = backup_database(source, output)
        assert pages == page_count(source)
        assert pages > 0
        copied = sqlite3.connect(output)
        try:
            row = copied.execute("SELECT name FROM products WHERE id = 'SUIT-001'").fetchone()
            assert row[0] == "黑色双排扣西装"
            variants = copied.execute("SELECT COUNT(*) FROM product_variants").fetchone()[0]
            assert variants == 3
        finally:
            copied.close()

    def test_same_path_rejected(self, tmp_path: Path) -> None:
        source = tmp_path / "chatty.sqlite"
        make_source(source)
        with pytest.raises(ValueError, match="^backup output must differ from source$"):
            backup_database(source, source)
        # 相对/绝对写法指向同一文件也要拒绝（resolve 后比较）
        with pytest.raises(ValueError, match="^backup output must differ from source$"):
            backup_database(source, tmp_path / "sub" / ".." / "chatty.sqlite")

    def test_creates_output_parent_directories(self, tmp_path: Path) -> None:
        source = tmp_path / "chatty.sqlite"
        output = tmp_path / "nested" / "deep" / "backup.sqlite"
        make_source(source)
        backup_database(source, output)
        assert output.exists()

    def test_online_backup_of_live_database(self, tmp_path: Path) -> None:
        source = tmp_path / "chatty.sqlite"
        output = tmp_path / "backup.sqlite"
        store = CommerceStore(source)  # 源库保持打开（在用库快照）
        try:
            pages = backup_database(source, output)
            assert pages > 0
        finally:
            store.close()
        copied = sqlite3.connect(output)
        try:
            count = copied.execute("SELECT COUNT(*) FROM products").fetchone()[0]
            assert count == 1
        finally:
            copied.close()


class TestCli:
    def test_outputs_single_line_json(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        source = tmp_path / "chatty.sqlite"
        output = tmp_path / "backup.sqlite"
        make_source(source)
        main(["--database", str(source), "--output", str(output)])
        captured = capsys.readouterr().out
        assert captured.count("\n") == 1
        payload = json.loads(captured)
        assert list(payload.keys()) == ["database", "output", "pages"]
        assert payload["database"] == str(source.resolve())
        assert payload["output"] == str(output.resolve())
        assert payload["pages"] == page_count(source)

    def test_missing_output_raises(self) -> None:
        with pytest.raises(ValueError, match="^--output is required$"):
            main([])

    def test_database_defaults_to_data_chatty_sqlite(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        monkeypatch.chdir(tmp_path)
        make_source(tmp_path / "data" / "chatty.sqlite")
        main(["--output", str(tmp_path / "backup.sqlite")])
        payload = json.loads(capsys.readouterr().out)
        assert payload["database"] == str((tmp_path / "data" / "chatty.sqlite").resolve())
        assert payload["pages"] > 0
