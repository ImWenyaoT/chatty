from __future__ import annotations

import sqlite3
from pathlib import Path
from threading import RLock

from chatty import config
from chatty.seed import seed_database

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
    product_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents > 0),
    description TEXT NOT NULL,
    brand TEXT NOT NULL,
    seller_id TEXT NOT NULL,
    stock INTEGER NOT NULL CHECK (stock >= 0),
    tags_json TEXT NOT NULL,
    popularity_score REAL NOT NULL,
    image_url TEXT NOT NULL,
    source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY,
    segment TEXT NOT NULL,
    preferred_categories_json TEXT NOT NULL,
    min_price_cents INTEGER NOT NULL,
    max_price_cents INTEGER NOT NULL,
    recent_views_json TEXT NOT NULL,
    recent_purchases_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS marketing_templates (
    segment TEXT PRIMARY KEY,
    tone TEXT NOT NULL,
    instructions TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS forbidden_words (
    word TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS seed_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    product_id TEXT,
    source TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_documents_fts USING fts5(
    doc_id UNINDEXED,
    title,
    content,
    category,
    product_id UNINDEXED,
    tokenize = 'unicode61'
);
"""


class Database:
    """初始化 SQLite；JSON/JSONL 种子不会进入运行时查询路径。"""

    def __init__(
        self,
        path: str | Path | None = None,
        *,
        data_dir: str | Path | None = None,
    ) -> None:
        self.path = Path(path or config.DATABASE_PATH)
        self.data_dir = Path(data_dir or config.DATA_DIR)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        # 连接允许 FastAPI 线程池复用，所有访问仍由同一把锁串行保护。
        self._connection = sqlite3.connect(self.path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        try:
            with self._lock:
                self._connection.execute("PRAGMA journal_mode = WAL")
                self._connection.executescript(SCHEMA)
                seed_database(self._connection, self.data_dir)
        except Exception:
            self._connection.close()
            raise

    @property
    def connection(self) -> sqlite3.Connection:
        return self._connection

    @property
    def lock(self) -> RLock:
        return self._lock

    def close(self) -> None:
        with self._lock:
            self._connection.close()
