from __future__ import annotations

import sqlite3
from pathlib import Path

from chatty import config
from chatty.catalog import Catalog


def _count(catalog: Catalog, table: str) -> int:
    row = catalog.database.connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
    return int(row[0])


def _seed_line_count(filename: str) -> int:
    """种子文件的有效行数，作为入库条数的期望值。"""
    text = (config.DATA_DIR / filename).read_text(encoding="utf-8")
    return sum(1 for line in text.splitlines() if line.strip())


def test_sqlite_is_seeded_with_business_and_knowledge_data(tmp_path: Path) -> None:
    database_path = tmp_path / "chatty.db"
    catalog = Catalog(database_path=database_path)

    assert database_path.exists()
    # 断言结构而非具体条数：加 demo 数据不该导致测试失败。
    assert _count(catalog, "products") == _seed_line_count("products.jsonl")
    assert _count(catalog, "knowledge_documents") == _seed_line_count("knowledge_documents.jsonl")
    tables = {
        row[0]
        for row in catalog.database.connection.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
        ).fetchall()
    }
    assert {
        "products",
        "user_profiles",
        "marketing_templates",
        "knowledge_documents",
        "knowledge_documents_fts",
    } <= tables
    catalog.close()


def test_fts5_retrieves_grounding_for_candidate_products(tmp_path: Path) -> None:
    catalog = Catalog(database_path=tmp_path / "chatty.db")

    hits = catalog.retrieve_knowledge(
        "降噪 耳机",
        categories=["耳机"],
        product_ids=["P003", "P004"],
        limit=3,
    )

    assert hits
    assert {hit.product_id for hit in hits if hit.product_id} <= {"P003", "P004"}
    assert all(hit.source == "generated-demo" for hit in hits)
    assert all(0 <= hit.relevance_score <= 1 for hit in hits)
    catalog.close()


def test_seed_repairs_a_partial_database(tmp_path: Path) -> None:
    database_path = tmp_path / "chatty.db"
    first = Catalog(database_path=database_path)
    first.close()

    with sqlite3.connect(database_path) as connection:
        connection.execute("DELETE FROM knowledge_documents WHERE doc_id = 'K001'")

    second = Catalog(database_path=database_path)
    knowledge_count = _seed_line_count("knowledge_documents.jsonl")
    assert _count(second, "products") == _seed_line_count("products.jsonl")
    assert _count(second, "knowledge_documents") == knowledge_count
    # FTS 表索引的是**块**不是整篇文档，长文档会被切成多块，所以条数更多
    assert _count(second, "knowledge_documents_fts") > knowledge_count
    second.close()


def test_long_documents_are_split_into_chunks() -> None:
    """长文档必须被切块索引，短文档保持整篇一块。

    分块的意义：检索命中后返回的是精准段落，而不是整篇几百字的文章——
    后者既浪费上下文，也让模型更难找到真正相关的那句话。
    """
    from chatty.database import split_into_chunks

    # 短文档不切
    short = "降噪耳机通勤场景应关注主动降噪、佩戴舒适度和续航。"
    assert split_into_chunks(short) == [short]

    # 长文档按句子边界切开，每块都是完整句子
    long_text = "".join(f"这是第{i}句用来凑长度的测试文本内容。" for i in range(30))
    chunks = split_into_chunks(long_text)
    assert len(chunks) > 1
    for chunk in chunks:
        assert chunk.endswith("。"), f"块没有在句子边界结束：{chunk[-20:]}"

    # 相邻块之间有重叠，避免关键信息落在接缝处被切断
    assert chunks[0][-10:] in chunks[1]


def test_chunks_preserve_original_text_for_display(catalog: Catalog) -> None:
    """FTS 表同时存"分词版"和"原文版"：前者建索引，后者返回给模型。"""
    hits = catalog.retrieve_knowledge("降噪 耳机", categories=["耳机"], product_ids=[], limit=3)
    assert hits
    for hit in hits:
        # 返回给模型的内容不能带建索引用的分词空格
        assert "  " not in hit.content, f"返回内容含分词空格：{hit.content[:40]}"
        assert hit.chunk_ordinal >= 0


def test_query_rewrite_bridges_synonym_gap(catalog: Catalog) -> None:
    """查询改写把用户说法补上知识库用词，解决 BM25 只认字面的问题。

    这是稀疏检索的固有短板（稠密检索正是为解决它而生）。
    在不引入嵌入模型的前提下，同义词扩展是成本最低的缓解手段。
    """
    rewrite = catalog.retriever.rewrite_query

    # 用户说"保护视力"，知识库写的是"护眼"
    assert "护眼" in rewrite("保护视力 不伤眼")
    # 原词必须保留——改写是**扩展**不是**替换**，映射不准也只是多召回几条
    assert "保护视力" in rewrite("保护视力 不伤眼")
    # 知识库用词已经在查询里就不重复添加
    assert rewrite("护眼 台灯").count("护眼") == 1
    # 没有同义词的查询原样返回
    assert rewrite("iPhone 16") == "iPhone 16"

    # 端到端验证：改写前召回不到的查询，现在能召回
    hits = catalog.retrieve_knowledge(
        "保护视力 不伤眼", categories=["家电"], product_ids=[], limit=5
    )
    assert hits, "同义词查询应当能召回到写着'护眼'的文档"
