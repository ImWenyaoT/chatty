"""从 SQLite 里读数据的两条路径。

放在同一个文件，是因为它们查的是同一个库、用的是同一把锁，
区别只在查询方式：

  · CommerceRepository —— 结构化查询：按主键、类目、价格取商品和画像
  · KnowledgeRetriever —— 全文检索：FTS5 倒排索引 + BM25 相关度排序

两者都只负责"把数据库里的行变成业务对象"，不做任何推荐决策——
那是 catalog.py 的事。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import cast

from chatty import config
from chatty.database import Database, segment_for_index
from chatty.models import (
    KnowledgeHit,
    MarketingStrategy,
    Product,
    UserProfile,
    UserSegment,
)

# ============================================================================
# 结构化查询
# ============================================================================


class CommerceRepository:
    """把 SQLite 行转换成业务模型，不承载推荐决策。"""

    def __init__(self, database: Database) -> None:
        self.database = database

    def list_products(self) -> list[Product]:
        with self.database.lock:
            rows = self.database.connection.execute(
                "SELECT * FROM products ORDER BY product_id"
            ).fetchall()
        return [
            Product(
                product_id=row["product_id"],
                name=row["name"],
                category=row["category"],
                price_cents=row["price_cents"],
                description=row["description"],
                brand=row["brand"],
                seller_id=row["seller_id"],
                stock=row["stock"],
                tags=json.loads(row["tags_json"]),
                popularity_score=row["popularity_score"],
                image_url=row["image_url"],
                source=row["source"],
            )
            for row in rows
        ]

    def profiles(self) -> dict[str, UserProfile]:
        """读出全部用户画像，返回 {user_id: 画像} 的字典。"""
        # database.lock 是一把跨线程的锁：SQLite 连接被多处共用，
        # 所有读写都要在这把锁里进行，避免并发访问同一个连接。
        with self.database.lock:
            rows = self.database.connection.execute(
                "SELECT * FROM user_profiles ORDER BY user_id"
            ).fetchall()
        return {
            row["user_id"]: UserProfile(
                user_id=row["user_id"],
                # cast 只是告诉类型检查器"这个字符串一定是五个分群之一"，
                # 运行时什么也不做。真正的校验发生在 Pydantic 构造 UserProfile 时。
                segment=cast(UserSegment, row["segment"]),
                preferred_categories=json.loads(row["preferred_categories_json"]),
                min_price_cents=row["min_price_cents"],
                max_price_cents=row["max_price_cents"],
                recent_views=json.loads(row["recent_views_json"]),
                recent_purchases=json.loads(row["recent_purchases_json"]),
            )
            for row in rows
        }

    def marketing_strategies(self, forbidden_words: list[str]) -> dict[str, MarketingStrategy]:
        with self.database.lock:
            rows = self.database.connection.execute(
                "SELECT * FROM marketing_templates ORDER BY segment"
            ).fetchall()
        return {
            row["segment"]: MarketingStrategy(
                segment=cast(UserSegment, row["segment"]),
                tone=row["tone"],
                instructions=row["instructions"],
                forbidden_words=forbidden_words,
            )
            for row in rows
        }

    def forbidden_words(self) -> list[str]:
        with self.database.lock:
            rows = self.database.connection.execute(
                "SELECT word FROM forbidden_words ORDER BY rowid"
            ).fetchall()
        return [row["word"] for row in rows]

    def inventory(self, product_ids: list[str]) -> list[Product]:
        if not product_ids:
            return []
        products = {product.product_id: product for product in self.list_products()}
        return [
            product
            for product_id in dict.fromkeys(product_ids)
            if (product := products.get(product_id)) is not None and product.stock > 0
        ]


# ============================================================================
# 全文检索（FTS5 + BM25）
# ============================================================================

_TOKEN_PATTERN = re.compile(r"[\w\u4e00-\u9fff]+", re.UNICODE)


def _load_synonyms(data_dir: Path) -> dict[str, list[str]]:
    """读同义词表，返回 {用户可能的说法: [知识库里的对应词]}。

    文件里写的是「知识库用词 → 用户说法列表」（这样人工维护最直观），
    这里把它反转成「用户说法 → 知识库用词」，因为检索时是拿用户的话去查。
    """
    path = data_dir / "query_synonyms.json"
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    reversed_map: dict[str, list[str]] = {}
    for canonical, variants in raw.items():
        if canonical.startswith("_"):  # 跳过 _note 之类的说明字段
            continue
        for variant in variants:
            reversed_map.setdefault(variant, []).append(canonical)
    return reversed_map


class KnowledgeRetriever:
    """基于 SQLite FTS5 全文索引 + BM25 排序的检索器（属于稀疏检索，不用向量）。

    索引单位是**块**：长文档切开后逐块入库，检索命中哪块就返回哪块，
    模型拿到的是精准段落而不是整篇几百字的文章。
    """

    def __init__(self, database: Database, data_dir: Path | None = None) -> None:
        self.database = database
        self.synonyms = _load_synonyms(data_dir or config.DATA_DIR)

    def rewrite_query(self, query: str) -> str:
        """查询改写：把用户的说法补上知识库里的对应词。

        BM25 是纯字面匹配，查"保护视力"命中不了写着"护眼"的文档——
        这是稀疏检索的固有短板（教材 3.2 说稠密检索正是为解决它而生）。
        在没有嵌入模型的情况下，同义词扩展是成本最低的缓解手段：
        把用户的说法映射回知识库用词，两边就对得上了。

        注意是**扩展**不是**替换**：原词保留，同义词追加在后面，
        这样即使映射不准也只是多召回几条，不会丢掉本来能命中的结果。

        例："保护视力 不伤眼" -> "保护视力 不伤眼 护眼"
        """
        if not self.synonyms:
            return query
        tokens = _TOKEN_PATTERN.findall(query)
        extra: list[str] = []
        for token in tokens:
            for canonical in self.synonyms.get(token, []):
                # 知识库用词已经在查询里就不必重复添加
                if canonical not in query and canonical not in extra:
                    extra.append(canonical)
        return f"{query} {' '.join(extra)}" if extra else query

    @staticmethod
    def _match_expression(query: str) -> str:
        """把自由文本查询转成安全的 FTS5 MATCH 表达式。

        例："降噪 耳机" -> '" 降  噪 " OR " 耳  机 "'

        汉字之间插空格是为了和索引侧对齐（见 database.segment_for_index）：
        两侧都按字切分后，加引号的短语查询才能匹配文档里连续的汉字。
        """
        # 限制词数并逐词加引号，避免把用户输入直接拼成 FTS5 语法。
        # 不加引号的话，输入里的 AND / OR / NEAR / * 会被 FTS5 当成运算符执行，
        # 性质等同于 SQL 注入；截断到 8 个词则是防止超长查询拖慢检索。
        #
        # 注意：截断属于"静默输入转换"——模型传了 10 个词，实际只用了 8 个。
        # 教材 4.2 强调"模型感知到的世界与工具操作的世界之间不能有系统性偏差"，
        # 所以这条限制必须写进工具描述告诉模型（见 tools.py 里 retrieve_knowledge 的描述），
        # 否则模型会以为长查询更精确，实际上多写的部分根本没生效。
        tokens = _TOKEN_PATTERN.findall(query.casefold())[:8]
        return " OR ".join(f'"{segment_for_index(token).strip()}"' for token in tokens)

    def retrieve(
        self,
        query: str,
        *,
        categories: list[str],
        product_ids: list[str],
        limit: int,
    ) -> list[KnowledgeHit]:
        # 先做查询改写（补同义词），再转成 FTS5 表达式
        expression = self._match_expression(self.rewrite_query(query))
        if not expression:
            return []  # 查询里一个有效词都没有，直接返回空

        # 下面逐段拼 SQL 的 WHERE 条件。注意范围过滤是写进 SQL 的，
        # 不是"先全量检索再在 Python 里过滤"——先缩小范围，BM25 才算得准也算得快。
        filters: list[str] = []
        parameters: list[str | int] = [expression]
        if categories:
            placeholders = ", ".join("?" for _ in categories)
            filters.append(f"knowledge_documents_fts.category IN ({placeholders})")
            parameters.extend(categories)
        if product_ids:
            placeholders = ", ".join("?" for _ in product_ids)
            # IS NULL 这一支是为了保留"通用知识"——不绑定具体商品的文档
            # （比如品类导购、营销规范）也应该能被检索到。
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
                -- title/category 等取自原表：FTS 表里存的是按字切分后的索引文本，
                -- 直接返回会得到「 降  噪  耳  机 」这样带空格的内容。
                -- content 例外——它必须是**命中的那个块**。FTS 表里为此存了两份：
                -- content 是按字切分后的版本（只用来建索引），
                -- raw_content 是同一个块的原文（直接返回给模型）。
                SELECT knowledge_documents.doc_id,
                       knowledge_documents.title,
                       knowledge_documents_fts.chunk_ordinal,
                       knowledge_documents_fts.raw_content AS chunk_content,
                       knowledge_documents.category,
                       knowledge_documents.product_id,
                       knowledge_documents.source,
                       -- bm25() 是 SQLite FTS5 内置的相关度打分函数，
                       -- 综合词频和文档频率给出排序依据（返回负值，越小越相关）。
                       bm25(knowledge_documents_fts) AS rank
                FROM knowledge_documents_fts
                JOIN knowledge_documents USING (doc_id)
                -- MATCH 触发 FTS5 全文索引查询；filter_sql 是上面拼好的范围约束。
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
                chunk_ordinal=row["chunk_ordinal"],
                content=row["chunk_content"],
                category=row["category"],
                product_id=row["product_id"],
                source=row["source"],
                # SQLite bm25 越小越相关；转换成便于接口展示的 0 到 1 分数。
                # 取绝对值再做 1/(1+x)：原始分越接近 0（越相关），结果越接近 1。
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
