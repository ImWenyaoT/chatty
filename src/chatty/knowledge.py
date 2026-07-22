"""Chatty 知识库：FTS5 trigram + 单字索引 + JSONL 全量导入 + 三层回退检索。

规格：specs/stores.md §5。构造函数接收已打开的连接（生产复用 commerce.database）；
importJsonl 走 BEGIN IMMEDIATE 全量重建；search 为 catch-all 口径（TS 权威，
decisions.md §6：任何异常 → knowledge_search_unavailable）。
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
from pathlib import Path

from pydantic import ValidationError

from chatty.contracts import KnowledgeRecord, KnowledgeSearchResult
from chatty.store import database_write_lock, write_transaction

_SEARCHABLE_COLUMNS = ("title", "summary", "body", "tags")


class KnowledgeStore:
    """Imports seller-authored chunks and exposes one bounded lexical search seam."""

    def __init__(self, connection: sqlite3.Connection) -> None:
        self.database = connection
        connection.row_factory = sqlite3.Row
        main_file = self._main_database_file(connection)
        self._write_lock = database_write_lock(main_file) if main_file else threading.RLock()
        connection.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
                id UNINDEXED,
                title,
                summary,
                body,
                source UNINDEXED,
                tags,
                tokenize='trigram'
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS knowledge_character_index (
                record_rowid INTEGER NOT NULL,
                character TEXT NOT NULL,
                PRIMARY KEY (record_rowid, character)
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS knowledge_character_lookup
            ON knowledge_character_index (character, record_rowid)
            """
        )

    def import_jsonl(self, source_path: str | Path) -> int:
        """全量重建：解析阶段任何失败都不动库；重建阶段在 BEGIN IMMEDIATE 事务内。"""
        records: list[KnowledgeRecord] = []
        seen_ids: set[str] = set()
        for line_number, line in enumerate(
            Path(source_path).read_text(encoding="utf-8").splitlines(), start=1
        ):
            if not line.strip():
                continue
            try:
                record = KnowledgeRecord.model_validate_json(line)
            except ValidationError as error:
                raise ValueError(f"invalid knowledge record on line {line_number}") from error
            if record.id in seen_ids:
                raise ValueError(f"duplicate knowledge id on line {line_number}: {record.id}")
            seen_ids.add(record.id)
            records.append(record)

        with write_transaction(self.database, self._write_lock) as connection:
            connection.execute("DELETE FROM knowledge_fts")
            connection.execute("DELETE FROM knowledge_character_index")
            for rowid, record in enumerate(records, start=1):
                tags_json = json.dumps(record.tags, ensure_ascii=False, separators=(",", ":"))
                connection.execute(
                    """
                    INSERT INTO knowledge_fts (rowid, id, title, summary, body, source, tags)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        rowid,
                        record.id,
                        record.title,
                        record.summary,
                        record.body,
                        record.source,
                        tags_json,
                    ),
                )
                connection.executemany(
                    """
                    INSERT INTO knowledge_character_index (record_rowid, character)
                    VALUES (?, ?)
                    """,
                    [
                        (rowid, character)
                        for character in self._record_characters(record, tags_json)
                    ],
                )
        return len(records)

    def search(self, query: str, *, limit: int) -> KnowledgeSearchResult:
        normalized = " ".join(query.split())
        if not normalized:
            return KnowledgeSearchResult(status="ok", query=query, results=[])
        if len(normalized) > 500:
            return KnowledgeSearchResult(
                status="error",
                query=query,
                results=[],
                error="invalid_knowledge_query",
            )
        safe_limit = max(1, min(limit, 10))
        try:
            rows = self._search_rows(normalized, safe_limit)
            return KnowledgeSearchResult(
                status="ok",
                query=query,
                results=[self._record_from_row(row) for row in rows],
            )
        except Exception:
            # TS catch-all：SQL 错误、损坏行、契约不符统一降级，不外抛。
            return KnowledgeSearchResult(
                status="error",
                query=query,
                results=[],
                error="knowledge_search_unavailable",
            )

    # ------------------------------------------------------------------
    # 三层检索
    # ------------------------------------------------------------------

    def _search_rows(self, query: str, limit: int) -> list[sqlite3.Row]:
        fragments = self._lexical_fragments(query)
        if fragments:
            match_expression = " OR ".join(
                '"{}"'.format(fragment.replace('"', '""')) for fragment in fragments
            )
            rows = self.database.execute(
                """
                SELECT id, title, summary, body, source, tags
                FROM knowledge_fts
                WHERE knowledge_fts MATCH ?
                ORDER BY bm25(knowledge_fts), rowid
                LIMIT ?
                """,
                (match_expression, limit),
            ).fetchall()
            if rows:
                return rows
        terms = self._query_terms(query)
        exact_rows = self._short_term_rows(terms, limit)
        if exact_rows:
            return exact_rows
        return self._fuzzy_rows(terms, limit)

    @staticmethod
    def _lexical_fragments(query: str) -> list[str]:
        fragments: list[str] = []
        for term in re.findall(r"\w+", query):
            if len(term) < 3:
                continue
            fragments.extend(term[index : index + 3] for index in range(len(term) - 2))
        return list(dict.fromkeys(fragments))

    @staticmethod
    def _query_terms(query: str) -> list[str]:
        return re.findall(r"\w+", query)

    def _short_term_rows(self, terms: list[str], limit: int) -> list[sqlite3.Row]:
        if not terms:
            return []
        term_clauses: list[str] = []
        score_clauses: list[str] = []
        where_params: list[str] = []
        score_params: list[str] = []
        for term in terms:
            escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            pattern = f"%{escaped}%"
            clause = " OR ".join(f"{column} LIKE ? ESCAPE '\\'" for column in _SEARCHABLE_COLUMNS)
            term_clauses.append(f"({clause})")
            where_params.extend([pattern] * len(_SEARCHABLE_COLUMNS))
            score_clauses.append(f"CASE WHEN {clause} THEN 1 ELSE 0 END")
            score_params.extend([pattern] * len(_SEARCHABLE_COLUMNS))
        statement = f"""
            SELECT id, title, summary, body, source, tags,
                   ({" + ".join(score_clauses)}) AS match_count
            FROM knowledge_fts
            WHERE {" OR ".join(term_clauses)}
            ORDER BY match_count DESC, rowid
            LIMIT ?
        """
        return self.database.execute(statement, (*score_params, *where_params, limit)).fetchall()

    def _fuzzy_rows(self, terms: list[str], limit: int) -> list[sqlite3.Row]:
        fuzzy_terms = [term for term in terms if 2 <= len(term) <= 10]
        characters = list(dict.fromkeys("".join(fuzzy_terms)))
        if not characters:
            return []
        placeholders = ", ".join("?" for _ in characters)
        candidates = self.database.execute(
            f"""
            SELECT knowledge_fts.id, title, summary, body, source, tags, knowledge_fts.rowid
            FROM knowledge_fts
            JOIN (
                SELECT record_rowid, COUNT(*) AS shared_characters
                FROM knowledge_character_index
                WHERE character IN ({placeholders})
                GROUP BY record_rowid
                ORDER BY shared_characters DESC, record_rowid
                LIMIT 20
            ) AS candidate ON candidate.record_rowid = knowledge_fts.rowid
            """,
            characters,
        ).fetchall()
        ranked: list[tuple[int, int, sqlite3.Row]] = []
        for row in candidates:
            searchable = f"{row['title']} {row['summary']} {row['tags']}"
            score = sum(1 for term in fuzzy_terms if self._has_close_substring(searchable, term))
            if score:
                ranked.append((-score, int(row["rowid"]), row))
        ranked.sort(key=lambda item: (item[0], item[1]))
        return [row for _, _, row in ranked[:limit]]

    # ------------------------------------------------------------------
    # 帮助函数
    # ------------------------------------------------------------------

    @staticmethod
    def _record_characters(record: KnowledgeRecord, tags_json: str) -> list[str]:
        # 注意：不含 body、不含 source；tags 用与存储相同的 JSON 串。
        searchable = f"{record.title} {record.summary} {tags_json}"
        return sorted(set(re.findall(r"\w", searchable)))

    @staticmethod
    def _has_close_substring(value: str, term: str) -> bool:
        for width in {max(1, len(term) - 1), len(term), len(term) + 1}:
            for start in range(max(0, len(value) - width + 1)):
                if KnowledgeStore._edit_distance(value[start : start + width], term) <= 1:
                    return True
        return False

    @staticmethod
    def _edit_distance(left: str, right: str) -> int:
        previous = list(range(len(right) + 1))
        for left_index, left_character in enumerate(left, start=1):
            current = [left_index]
            for right_index, right_character in enumerate(right, start=1):
                current.append(
                    min(
                        current[-1] + 1,
                        previous[right_index] + 1,
                        previous[right_index - 1] + (left_character != right_character),
                    )
                )
            previous = current
        return previous[-1]

    @staticmethod
    def _record_from_row(row: sqlite3.Row) -> KnowledgeRecord:
        return KnowledgeRecord(
            id=row["id"],
            title=row["title"],
            summary=row["summary"],
            body=row["body"],
            source=row["source"],
            tags=json.loads(row["tags"]),
        )

    @staticmethod
    def _main_database_file(connection: sqlite3.Connection) -> str:
        for row in connection.execute("PRAGMA database_list"):
            if row["name"] == "main":
                return str(row["file"] or "")
        return ""
