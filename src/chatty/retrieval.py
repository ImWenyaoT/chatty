from __future__ import annotations

import re

from chatty.database import Database
from chatty.models import KnowledgeHit

_TOKEN_PATTERN = re.compile(r"[\w\u4e00-\u9fff]+", re.UNICODE)


class KnowledgeRetriever:
    def __init__(self, database: Database) -> None:
        self.database = database

    @staticmethod
    def _match_expression(query: str) -> str:
        # 限制词数并逐词加引号，避免把用户输入直接拼成 FTS5 语法。
        tokens = _TOKEN_PATTERN.findall(query.casefold())[:8]
        return " OR ".join(f'"{token}"' for token in tokens)

    def retrieve(
        self,
        query: str,
        *,
        categories: list[str],
        product_ids: list[str],
        limit: int,
    ) -> list[KnowledgeHit]:
        expression = self._match_expression(query)
        if not expression:
            return []

        filters: list[str] = []
        parameters: list[str | int] = [expression]
        if categories:
            placeholders = ", ".join("?" for _ in categories)
            filters.append(f"knowledge_documents_fts.category IN ({placeholders})")
            parameters.extend(categories)
        if product_ids:
            placeholders = ", ".join("?" for _ in product_ids)
            filters.append(
                f"(knowledge_documents_fts.product_id IN ({placeholders}) "
                "OR knowledge_documents_fts.product_id IS NULL)"
            )
            parameters.extend(product_ids)
        filter_sql = f" AND {' AND '.join(filters)}" if filters else ""
        parameters.append(limit)

        with self.database.lock:
            rows = self.database.connection.execute(
                f"""
                SELECT knowledge_documents_fts.doc_id,
                       knowledge_documents_fts.title,
                       knowledge_documents_fts.content,
                       knowledge_documents_fts.category,
                       knowledge_documents_fts.product_id,
                       knowledge_documents.source,
                       bm25(knowledge_documents_fts) AS rank
                FROM knowledge_documents_fts
                JOIN knowledge_documents USING (doc_id)
                WHERE knowledge_documents_fts MATCH ?{filter_sql}
                ORDER BY rank
                LIMIT ?
                """,
                parameters,
            ).fetchall()
        return [
            KnowledgeHit(
                doc_id=row["doc_id"],
                title=row["title"],
                content=row["content"],
                category=row["category"],
                product_id=row["product_id"],
                source=row["source"],
                # SQLite bm25 越小越相关；转换成便于接口展示的 0 到 1 分数。
                relevance_score=round(1 / (1 + abs(row["rank"])), 4),
            )
            for row in rows
        ]

    def count(self) -> int:
        with self.database.lock:
            row = self.database.connection.execute(
                "SELECT COUNT(*) FROM knowledge_documents"
            ).fetchone()
        return int(row[0])
