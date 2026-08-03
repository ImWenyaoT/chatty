"""SQLite 数据库及知识文档索引。"""

import json
import re
import sqlite3
from pathlib import Path
from typing import TypeVar

from pydantic import BaseModel

from app.models import (
    USER_SEGMENTS,
    KnowledgeDocument,
    Product,
    UserProfile,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data"

CHINESE_CHARACTER = re.compile(r"[\u4e00-\u9fff]")
SENTENCE_END = re.compile(r"(?<=[。！？；])")


def segment_for_index(text: str) -> str:
    """在中文字符两侧加空格，让 SQLite unicode61 能按字建立索引。"""

    return CHINESE_CHARACTER.sub(lambda match: f" {match.group(0)} ", text)


def split_into_chunks(text: str, target: int = 160, overlap: int = 40) -> list[str]:
    """优先在中文句末切块；跨块保留少量重叠上下文。"""

    normalized = text.strip()
    if not normalized:
        return []
    if len(normalized) <= target:
        return [normalized]

    chunks: list[str] = []
    current = ""
    sentences = [part for part in SENTENCE_END.split(normalized) if part.strip()]

    for sentence in sentences:
        if not current or len(current) + len(sentence) <= target:
            current += sentence
            continue

        chunks.append(current.strip())
        prefix = ""
        if overlap > 0:
            prefix = current[-overlap:]
        current = prefix + sentence

    if current.strip():
        chunks.append(current.strip())
    return chunks


SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
  product_id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0), description TEXT NOT NULL,
  brand TEXT NOT NULL, seller_id TEXT NOT NULL,
  stock INTEGER NOT NULL CHECK (stock >= 0),
  tags_json TEXT NOT NULL, popularity_score REAL NOT NULL, image_url TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY, segment TEXT NOT NULL,
  preferred_categories_json TEXT NOT NULL,
  min_price_cents INTEGER NOT NULL, max_price_cents INTEGER NOT NULL,
  recent_views_json TEXT NOT NULL, recent_purchases_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS marketing_templates (
  segment TEXT PRIMARY KEY, tone TEXT NOT NULL, instructions TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS forbidden_words (word TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  content TEXT NOT NULL, category TEXT NOT NULL, product_id TEXT, source TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_documents_fts USING fts5(
  doc_id UNINDEXED, chunk_ordinal UNINDEXED, title, content, raw_content UNINDEXED,
  category, product_id UNINDEXED, tokenize = 'unicode61'
);
"""

ModelT = TypeVar("ModelT", bound=BaseModel)


def _read_json_lines(path: Path, model: type[ModelT]) -> list[ModelT]:
    items: list[ModelT] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            items.append(model.model_validate_json(line))
    return items


class SeedDataError(ValueError):
    """种子数据不满足演示业务约束。"""


class Database:
    """创建数据库，并把 JSON 种子投影为运行时 SQLite 数据。"""

    def __init__(
        self,
        path: str | Path = ":memory:",
        data_dir: str | Path = DATA_DIR,
    ) -> None:
        self.connection = sqlite3.connect(path)
        self.connection.row_factory = sqlite3.Row

        try:
            self.connection.execute("PRAGMA journal_mode = WAL")
            self.connection.executescript(SCHEMA)
            self._seed(Path(data_dir))
        except Exception:
            self.connection.close()
            raise

    def close(self) -> None:
        self.connection.close()

    def _seed(self, data_dir: Path) -> None:
        products = _read_json_lines(data_dir / "products.jsonl", Product)
        profiles = _read_json_lines(data_dir / "user_profiles.jsonl", UserProfile)
        documents = _read_json_lines(
            data_dir / "knowledge_documents.jsonl", KnowledgeDocument
        )
        templates = json.loads(
            (data_dir / "marketing_templates.json").read_text(encoding="utf-8")
        )
        forbidden_words = json.loads(
            (data_dir / "forbidden_words.json").read_text(encoding="utf-8")
        )

        if set(templates) != set(USER_SEGMENTS):
            raise SeedDataError("invalid_marketing_segments")
        if len(set(forbidden_words)) != len(forbidden_words):
            raise SeedDataError("duplicate_forbidden_word")

        connection = self.connection
        try:
            connection.execute("BEGIN IMMEDIATE")
            for table in (
                "knowledge_documents_fts",
                "knowledge_documents",
                "forbidden_words",
                "marketing_templates",
                "user_profiles",
                "products",
            ):
                connection.execute(f"DELETE FROM {table}")

            for product in products:
                connection.execute(
                    "INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        product.product_id,
                        product.name,
                        product.category,
                        product.price_cents,
                        product.description,
                        product.brand,
                        product.seller_id,
                        product.stock,
                        json.dumps(product.tags, ensure_ascii=False),
                        product.popularity_score,
                        product.image_url,
                        product.source,
                    ),
                )

            for profile in profiles:
                connection.execute(
                    "INSERT INTO user_profiles VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        profile.user_id,
                        profile.segment,
                        json.dumps(profile.preferred_categories, ensure_ascii=False),
                        profile.min_price_cents,
                        profile.max_price_cents,
                        json.dumps(profile.recent_views, ensure_ascii=False),
                        json.dumps(profile.recent_purchases, ensure_ascii=False),
                    ),
                )

            for segment, template in templates.items():
                connection.execute(
                    "INSERT INTO marketing_templates VALUES (?, ?, ?)",
                    (segment, template["tone"], template["instructions"]),
                )
            for word in forbidden_words:
                connection.execute("INSERT INTO forbidden_words VALUES (?)", (word,))

            row_id = 0
            for document in documents:
                connection.execute(
                    """INSERT INTO knowledge_documents
                       (doc_id, title, content, category, product_id, source)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        document.doc_id,
                        document.title,
                        document.content,
                        document.category,
                        document.product_id,
                        document.source,
                    ),
                )
                for ordinal, chunk in enumerate(split_into_chunks(document.content)):
                    row_id += 1
                    connection.execute(
                        """INSERT INTO knowledge_documents_fts
                           (rowid, doc_id, chunk_ordinal, title, content,
                            raw_content, category, product_id)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            row_id,
                            document.doc_id,
                            ordinal,
                            segment_for_index(document.title),
                            segment_for_index(chunk),
                            chunk,
                            document.category,
                            document.product_id,
                        ),
                    )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
