from __future__ import annotations

import sqlite3
from pathlib import Path

from chatty.catalog import Catalog


def _count(catalog: Catalog, table: str) -> int:
    row = catalog.database.connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
    return int(row[0])


def test_sqlite_is_seeded_with_business_and_knowledge_data(tmp_path: Path) -> None:
    database_path = tmp_path / "chatty.db"
    catalog = Catalog(database_path=database_path)

    assert database_path.exists()
    assert _count(catalog, "products") == 20
    assert _count(catalog, "knowledge_documents") == 12
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
        "seed_metadata",
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
    assert _count(second, "products") == 20
    assert _count(second, "knowledge_documents") == 12
    assert _count(second, "knowledge_documents_fts") == 12
    second.close()
