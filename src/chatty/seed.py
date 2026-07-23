from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

from pydantic import BaseModel, TypeAdapter

from chatty.models import KnowledgeDocument, Product, UserProfile

_SEGMENTS = {
    "new_user",
    "active",
    "high_value",
    "price_sensitive",
    "churn_risk",
}
_SEED_FILES = (
    "products.jsonl",
    "user_profiles.jsonl",
    "marketing_templates.json",
    "forbidden_words.json",
    "knowledge_documents.jsonl",
)


class SeedDataError(RuntimeError):
    pass


def _model_lines[ModelT: BaseModel](path: Path, model: type[ModelT]) -> list[ModelT]:
    return [
        model.model_validate_json(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _fingerprint(data_dir: Path) -> str:
    digest = hashlib.sha256()
    for name in _SEED_FILES:
        digest.update(name.encode())
        digest.update((data_dir / name).read_bytes())
    return digest.hexdigest()


def _is_current(
    connection: sqlite3.Connection,
    fingerprint: str,
    expected_counts: dict[str, int],
) -> bool:
    row = connection.execute("SELECT value FROM seed_metadata WHERE key = 'fingerprint'").fetchone()
    if row is None or row[0] != fingerprint:
        return False
    return all(
        connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == count
        for table, count in expected_counts.items()
    )


def seed_database(connection: sqlite3.Connection, data_dir: Path) -> None:
    """把可读种子事务性投影到运行时唯一数据源 SQLite。"""

    products = _model_lines(data_dir / "products.jsonl", Product)
    profiles = _model_lines(data_dir / "user_profiles.jsonl", UserProfile)
    knowledge = _model_lines(
        data_dir / "knowledge_documents.jsonl",
        KnowledgeDocument,
    )
    templates = TypeAdapter(dict[str, dict[str, str]]).validate_json(
        (data_dir / "marketing_templates.json").read_text(encoding="utf-8")
    )
    forbidden_words = TypeAdapter(list[str]).validate_json(
        (data_dir / "forbidden_words.json").read_text(encoding="utf-8")
    )
    if set(templates) != _SEGMENTS:
        raise SeedDataError("invalid_marketing_segments")
    if len(forbidden_words) != len(set(forbidden_words)):
        raise SeedDataError("duplicate_forbidden_word")

    fingerprint = _fingerprint(data_dir)
    expected_counts = {
        "products": len(products),
        "user_profiles": len(profiles),
        "marketing_templates": len(templates),
        "forbidden_words": len(forbidden_words),
        "knowledge_documents": len(knowledge),
        "knowledge_documents_fts": len(knowledge),
    }
    if _is_current(connection, fingerprint, expected_counts):
        return

    # 单个事务内重建投影。任何一步失败都会回滚，避免半初始化数据库。
    with connection:
        for table in (
            "knowledge_documents_fts",
            "knowledge_documents",
            "forbidden_words",
            "marketing_templates",
            "user_profiles",
            "products",
            "seed_metadata",
        ):
            connection.execute(f"DELETE FROM {table}")

        connection.executemany(
            """
            INSERT INTO products (
                product_id, name, category, price_cents, description, brand,
                seller_id, stock, tags_json, popularity_score, image_url, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    item.product_id,
                    item.name,
                    item.category,
                    item.price_cents,
                    item.description,
                    item.brand,
                    item.seller_id,
                    item.stock,
                    json.dumps(item.tags, ensure_ascii=False),
                    item.popularity_score,
                    item.image_url,
                    item.source,
                )
                for item in products
            ],
        )
        connection.executemany(
            """
            INSERT INTO user_profiles (
                user_id, segment, preferred_categories_json, min_price_cents,
                max_price_cents, recent_views_json, recent_purchases_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    item.user_id,
                    item.segment,
                    json.dumps(item.preferred_categories, ensure_ascii=False),
                    item.min_price_cents,
                    item.max_price_cents,
                    json.dumps(item.recent_views, ensure_ascii=False),
                    json.dumps(item.recent_purchases, ensure_ascii=False),
                )
                for item in profiles
            ],
        )
        connection.executemany(
            "INSERT INTO marketing_templates (segment, tone, instructions) VALUES (?, ?, ?)",
            [
                (segment, template["tone"], template["instructions"])
                for segment, template in templates.items()
            ],
        )
        connection.executemany(
            "INSERT INTO forbidden_words (word) VALUES (?)",
            [(word,) for word in forbidden_words],
        )
        connection.executemany(
            """
            INSERT INTO knowledge_documents (
                doc_id, title, content, category, product_id, source
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    item.doc_id,
                    item.title,
                    item.content,
                    item.category,
                    item.product_id,
                    item.source,
                )
                for item in knowledge
            ],
        )
        connection.executemany(
            """
            INSERT INTO knowledge_documents_fts (
                rowid, doc_id, title, content, category, product_id
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    index,
                    item.doc_id,
                    item.title,
                    item.content,
                    item.category,
                    item.product_id,
                )
                for index, item in enumerate(knowledge, 1)
            ],
        )
        connection.execute(
            "INSERT INTO seed_metadata (key, value) VALUES ('fingerprint', ?)",
            (fingerprint,),
        )
