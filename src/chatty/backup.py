"""SQLite 在线备份（specs/stores.md §7）：Online Backup API + 单行 JSON 输出的 CLI。"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path


def backup_database(source_path: str | Path, output_path: str | Path) -> int:
    """整库在线备份到 output_path，返回拷贝的总页数（对在用库也能得到一致快照）。"""
    source = Path(source_path).resolve()
    output = Path(output_path).resolve()
    if source == output:
        raise ValueError("backup output must differ from source")
    output.parent.mkdir(parents=True, exist_ok=True)
    total_pages = 0
    source_connection = sqlite3.connect(source)
    try:
        output_connection = sqlite3.connect(output)
        try:

            def progress(status: int, remaining: int, total: int) -> None:
                nonlocal total_pages
                total_pages = total

            source_connection.backup(output_connection, progress=progress)
        finally:
            output_connection.close()
    finally:
        source_connection.close()
    return total_pages


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Back up the Chatty SQLite database")
    parser.add_argument("--database", default="data/chatty.sqlite")
    parser.add_argument("--output", default=None)
    args = parser.parse_args(argv)
    if not args.output:
        raise ValueError("--output is required")
    database = Path(args.database).resolve()
    output = Path(args.output).resolve()
    pages = backup_database(database, output)
    print(
        json.dumps(
            {"database": str(database), "output": str(output), "pages": pages},
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
