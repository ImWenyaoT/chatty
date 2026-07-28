"""SQLite 数据层：建表、导入种子数据、管理连接。

三件事放在一个文件里，是因为它们围绕同一个对象——那个 .db 文件：
表结构决定数据长什么样，种子导入负责把 JSON 填进去，连接管理负责让别人能读它。
拆成三个文件反而要来回跳。

阅读顺序（每节有 ===== 分隔）：
  1. 中文分词   —— FTS5 检索中文的前提，建索引和查索引都要用
  2. 表结构     —— 全部建表语句
  3. 种子导入   —— 把 data/ 下的 JSON 灌进 SQLite，用指纹避免重复导入
  4. 连接管理   —— Database 类，对外只暴露 connection 和 lock
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from pathlib import Path
from threading import RLock

from pydantic import BaseModel, TypeAdapter

from chatty import config
from chatty.models import KnowledgeDocument, Product, UserProfile

# ============================================================================
# 1. 中文分词
# ============================================================================

# 中日韩统一表意文字区间，即常用汉字
_CJK = re.compile(r"[一-鿿]")


def segment_for_index(text: str) -> str:
    """把文本里的每个汉字用空格隔开，供 FTS5 建立单字 token 索引。

    非中文部分（英文、数字、标点）保持原样，仍按 unicode61 的默认规则切分。

    >>> segment_for_index("价格敏感 iPhone 16")
    ' 价  格  敏  感  iPhone 16'
    """
    return _CJK.sub(lambda match: f" {match.group()} ", text)


_CHUNK_TARGET = 160  # 一个块的目标汉字数
_CHUNK_OVERLAP = 40  # 相邻块的重叠字数，防关键信息落在接缝处

# 中文句子的结束标记。切分优先在这些位置下刀，保证块内是完整的句子。
_SENTENCE_END = re.compile(r"(?<=[。！？；])")


def split_into_chunks(
    text: str,
    *,
    target: int = _CHUNK_TARGET,
    overlap: int = _CHUNK_OVERLAP,
) -> list[str]:
    """把长文档按句子边界切成若干块，用于建立检索索引。

    切在句号、问号这类自然边界上，块内始终是完整句子。
    短文档原样返回单个块。详见 docs/code-walkthrough.md。
    """
    text = text.strip()
    if not text:
        return []
    # 短文档没有切的必要，整篇当一个块
    if len(text) <= target:
        return [text]

    sentences = [part for part in _SENTENCE_END.split(text) if part.strip()]
    chunks: list[str] = []
    current = ""

    for sentence in sentences:
        # 当前块加上这句还没超长 → 继续装
        if len(current) + len(sentence) <= target or not current:
            current += sentence
            continue
        # 超长了 → 收下当前块，用它的尾部作为下一块的开头（重叠）
        chunks.append(current.strip())
        current = current[-overlap:] + sentence if overlap else sentence

    if current.strip():
        chunks.append(current.strip())
    return chunks


# ============================================================================
# 2. 表结构
# ============================================================================

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

-- FTS5 虚拟表：SQLite 内置的全文检索引擎，底层是倒排索引。
-- 标了 UNINDEXED 的列不参与全文索引，只用来做过滤和回传，索引因此更小更快。
-- tokenize='unicode61' 是 Unicode 分词器；中文靠 segment_for_index 按字切开来配合它。
--
-- **索引的单位是"块"而不是整篇文档**：长文档会先被 split_into_chunks 切开，
-- 每个块单独入库。这样检索命中的是精准的段落，而不是把整篇几百字的文章
-- 塞给模型——后者既浪费上下文，也让模型更难找到真正相关的那句话。
-- chunk_ordinal 记录块在原文中的序号，doc_id 用来追溯回原始文档。
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_documents_fts USING fts5(
    doc_id UNINDEXED,
    chunk_ordinal UNINDEXED,
    title,
    content,          -- 按字切分后的文本，只用来建索引，不适合展示
    raw_content UNINDEXED,  -- 同一个块的原文，检索命中后直接返回给模型
    category,
    product_id UNINDEXED,
    tokenize = 'unicode61'
);
"""


# ============================================================================
# 3. 种子数据导入
# ============================================================================

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
    """读 JSONL 文件，把每一行解析成指定的 Pydantic 模型。

    `[ModelT: BaseModel]` 是 Python 3.12 起的泛型写法，作用是告诉类型检查器：
    传进来什么模型类，返回的就是那个模型的列表。
    比如 `_model_lines(path, Product)` 的返回类型就是 `list[Product]`。
    不写它功能也一样，只是编辑器没法提示返回值里有哪些字段。
    """
    results = []
    for line in path.read_text(encoding="utf-8").splitlines():
        # 跳过空行：文件末尾常有一个换行符
        if not line.strip():
            continue
        # model_validate_json 会顺便校验字段类型，数据不合法这里就会报错
        results.append(model.model_validate_json(line))
    return results


def _fingerprint(data_dir: Path) -> str:
    """给整个 data/ 目录算一个指纹（SHA-256）。

    用途：启动时比对指纹，一样就说明种子数据没变、不用重新导入；
    不一样才重建。这样既避免每次启动都重复灌数据，
    又能在你改了 JSON 之后自动生效。
    """
    digest = hashlib.sha256()
    for name in _SEED_FILES:
        # 文件名也计入指纹，防止两个文件内容互换后指纹不变
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
        # FTS 表存的是块，数量多于文档数
        "knowledge_documents_fts": sum(len(split_into_chunks(item.content)) for item in knowledge),
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
        # FTS 表存按字切分后的文本（unicode61 会把整段中文当单个 token），
        # 长文档先切块入库，检索命中哪块返回哪块
        chunk_rows = []
        rowid = 0
        for item in knowledge:
            for ordinal, chunk in enumerate(split_into_chunks(item.content)):
                rowid += 1
                chunk_rows.append(
                    (
                        rowid,
                        item.doc_id,
                        ordinal,
                        segment_for_index(item.title),
                        segment_for_index(chunk),  # 建索引用
                        chunk,  # 原文，返回给模型用
                        item.category,
                        item.product_id,
                    )
                )
        connection.executemany(
            """
            INSERT INTO knowledge_documents_fts (
                rowid, doc_id, chunk_ordinal, title, content, raw_content,
                category, product_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            chunk_rows,
        )
        connection.execute(
            "INSERT INTO seed_metadata (key, value) VALUES ('fingerprint', ?)",
            (fingerprint,),
        )


# ============================================================================
# 4. 连接管理
# ============================================================================


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
        # 连接可能被多个线程复用，所有访问都由同一把锁串行保护。
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
