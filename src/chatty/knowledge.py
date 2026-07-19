from __future__ import annotations

import json
import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError


class KnowledgeRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=500)
    summary: str = Field(min_length=1, max_length=2_000)
    body: str = Field(min_length=1, max_length=20_000)
    source: str = Field(min_length=1, max_length=2_000)
    tags: list[str] = Field(default_factory=list, max_length=20)


class KnowledgeSearchResult(BaseModel):
    status: Literal["ok", "error"]
    query: str
    results: list[KnowledgeRecord]
    error: Literal["invalid_knowledge_query", "knowledge_search_unavailable"] | None = None


class KnowledgeStore:
    """Imports seller-authored chunks and exposes one bounded lexical search seam."""

    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
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

        with self._connect() as connection:
            connection.execute("DELETE FROM knowledge_fts")
            connection.execute("DELETE FROM knowledge_character_index")
            connection.executemany(
                """
                INSERT INTO knowledge_fts (rowid, id, title, summary, body, source, tags)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        rowid,
                        record.id,
                        record.title,
                        record.summary,
                        record.body,
                        record.source,
                        json.dumps(record.tags, ensure_ascii=False),
                    )
                    for rowid, record in enumerate(records, start=1)
                ],
            )
            connection.executemany(
                """
                INSERT INTO knowledge_character_index (record_rowid, character)
                VALUES (?, ?)
                """,
                [
                    (rowid, character)
                    for rowid, record in enumerate(records, start=1)
                    for character in self._record_characters(record)
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
            with self._connect() as connection:
                rows = self._search_rows(connection, normalized, safe_limit)
        except sqlite3.Error:
            return KnowledgeSearchResult(
                status="error",
                query=query,
                results=[],
                error="knowledge_search_unavailable",
            )
        return KnowledgeSearchResult(
            status="ok",
            query=query,
            results=[self._record_from_row(row) for row in rows],
        )

    def _search_rows(
        self, connection: sqlite3.Connection, query: str, limit: int
    ) -> list[sqlite3.Row]:
        fragments = self._lexical_fragments(query)
        if fragments:
            match_expression = " OR ".join(
                f'"{fragment.replace(chr(34), chr(34) * 2)}"' for fragment in fragments
            )
            rows = connection.execute(
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
        exact_rows = self._short_term_rows(connection, terms, limit)
        if exact_rows:
            return exact_rows
        return self._fuzzy_rows(connection, terms, limit)

    @staticmethod
    def _lexical_fragments(query: str) -> list[str]:
        fragments: list[str] = []
        for term in re.findall(r"[\w\u3400-\u9fff]+", query, flags=re.UNICODE):
            if len(term) < 3:
                continue
            fragments.extend(term[index : index + 3] for index in range(len(term) - 2))
        return list(dict.fromkeys(fragments))

    @staticmethod
    def _query_terms(query: str) -> list[str]:
        return re.findall(r"[\w\u3400-\u9fff]+", query, flags=re.UNICODE)

    def _short_term_rows(
        self, connection: sqlite3.Connection, terms: list[str], limit: int
    ) -> list[sqlite3.Row]:
        if not terms:
            return []
        searchable_columns = ("title", "summary", "body", "tags")
        term_clauses: list[str] = []
        score_clauses: list[str] = []
        params: list[str | int] = []
        score_params: list[str] = []
        for term in terms:
            escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            pattern = f"%{escaped}%"
            clause = " OR ".join(f"{column} LIKE ? ESCAPE '\\'" for column in searchable_columns)
            term_clauses.append(f"({clause})")
            params.extend([pattern] * len(searchable_columns))
            score_clauses.append(f"CASE WHEN {clause} THEN 1 ELSE 0 END")
            score_params.extend([pattern] * len(searchable_columns))
        statement = f"""
            SELECT id, title, summary, body, source, tags,
                   ({" + ".join(score_clauses)}) AS match_count
            FROM knowledge_fts
            WHERE {" OR ".join(term_clauses)}
            ORDER BY match_count DESC, rowid
            LIMIT ?
        """
        return connection.execute(statement, (*score_params, *params, limit)).fetchall()

    def _fuzzy_rows(
        self, connection: sqlite3.Connection, terms: list[str], limit: int
    ) -> list[sqlite3.Row]:
        fuzzy_terms = [term for term in terms if 2 <= len(term) <= 10]
        characters = list(dict.fromkeys("".join(fuzzy_terms)))
        if not characters:
            return []
        placeholders = ", ".join("?" for _ in characters)
        candidates = connection.execute(
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
            searchable_text = " ".join(str(row[column]) for column in ("title", "summary", "tags"))
            score = sum(
                1 for term in fuzzy_terms if self._has_close_substring(searchable_text, term)
            )
            if score:
                ranked.append((-score, int(row["rowid"]), row))
        ranked.sort(key=lambda item: (item[0], item[1]))
        return [row for _, _, row in ranked[:limit]]

    @staticmethod
    def _record_characters(record: KnowledgeRecord) -> list[str]:
        searchable_text = " ".join(
            (record.title, record.summary, json.dumps(record.tags, ensure_ascii=False))
        )
        return sorted(set(re.findall(r"[\w\u3400-\u9fff]", searchable_text, re.UNICODE)))

    @staticmethod
    def _has_close_substring(text: str, term: str) -> bool:
        for width in {max(1, len(term) - 1), len(term), len(term) + 1}:
            for start in range(max(0, len(text) - width + 1)):
                if KnowledgeStore._edit_distance(text[start : start + width], term) <= 1:
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

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()
