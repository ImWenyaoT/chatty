"""KnowledgeStore 契约测试：JSONL 全量导入、三层回退检索、catch-all 降级。"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from chatty.knowledge import KnowledgeStore
from chatty.sqlite import open_connection


def record(record_id: str, **overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": record_id,
        "title": "婚礼西装租赁指南",
        "summary": "深色西装租赁流程与押金说明",
        "body": "租期从取件日起算，归还需干洗。",
        "source": "faq#suit",
        "tags": ["西装", "租赁"],
    }
    payload.update(overrides)
    return payload


def write_jsonl(path: Path, records: list[dict[str, object]]) -> Path:
    path.write_text(
        "\n".join(json.dumps(item, ensure_ascii=False) for item in records) + "\n",
        encoding="utf-8",
    )
    return path


@pytest.fixture
def connection(tmp_path: Path) -> sqlite3.Connection:
    return open_connection(tmp_path / "chatty.sqlite")


@pytest.fixture
def store(connection: sqlite3.Connection) -> KnowledgeStore:
    return KnowledgeStore(connection)


@pytest.fixture
def seeded(store: KnowledgeStore, tmp_path: Path) -> KnowledgeStore:
    source = write_jsonl(
        tmp_path / "knowledge.jsonl",
        [
            record("k1"),
            record(
                "k2",
                title="衬衫尺码对照表",
                summary="衬衫尺码 M L XL 对照",
                body="领围与胸围数据。",
                source="faq#shirt",
                tags=["衬衫"],
            ),
        ],
    )
    assert store.import_jsonl(source) == 2
    return store


class TestImportJsonl:
    def test_returns_count_and_skips_blank_lines(
        self, store: KnowledgeStore, tmp_path: Path
    ) -> None:
        source = tmp_path / "knowledge.jsonl"
        lines = [
            json.dumps(record("k1"), ensure_ascii=False),
            "",
            "   ",
            json.dumps(record("k2"), ensure_ascii=False),
        ]
        source.write_text("\n".join(lines) + "\n", encoding="utf-8")
        assert store.import_jsonl(source) == 2

    def test_invalid_record_reports_line_number(
        self, store: KnowledgeStore, tmp_path: Path
    ) -> None:
        source = tmp_path / "bad.jsonl"
        lines = [
            json.dumps(record("k1"), ensure_ascii=False),
            "",
            "not-json",
        ]
        source.write_text("\n".join(lines), encoding="utf-8")
        # 行号从 1 计且包含空行
        with pytest.raises(ValueError, match="^invalid knowledge record on line 3$"):
            store.import_jsonl(source)

    def test_schema_violation_is_invalid_record(
        self, store: KnowledgeStore, tmp_path: Path
    ) -> None:
        bad = record("k1")
        bad["extra_field"] = "rejected"
        source = write_jsonl(tmp_path / "bad.jsonl", [bad])
        with pytest.raises(ValueError, match="^invalid knowledge record on line 1$"):
            store.import_jsonl(source)

    def test_duplicate_id_reports_line_and_id(
        self, store: KnowledgeStore, tmp_path: Path
    ) -> None:
        source = write_jsonl(
            tmp_path / "dup.jsonl", [record("k1"), record("k2"), record("k1")]
        )
        with pytest.raises(ValueError, match="^duplicate knowledge id on line 3: k1$"):
            store.import_jsonl(source)

    def test_failed_import_leaves_database_untouched(
        self, seeded: KnowledgeStore, tmp_path: Path
    ) -> None:
        source = write_jsonl(tmp_path / "dup.jsonl", [record("k9"), record("k9")])
        with pytest.raises(ValueError):
            seeded.import_jsonl(source)
        count = seeded.database.execute("SELECT COUNT(*) FROM knowledge_fts").fetchone()[0]
        assert count == 2  # 解析阶段失败不动库
        assert seeded.search("西装租赁", limit=5).results[0].id == "k1"

    def test_reimport_replaces_all_records(
        self, seeded: KnowledgeStore, tmp_path: Path
    ) -> None:
        source = write_jsonl(
            tmp_path / "replacement.jsonl",
            [record("k3", title="领带搭配技巧", summary="领带颜色搭配", tags=["领带"])],
        )
        assert seeded.import_jsonl(source) == 1
        rows = seeded.database.execute("SELECT id FROM knowledge_fts").fetchall()
        assert [row["id"] for row in rows] == ["k3"]
        index_count = seeded.database.execute(
            "SELECT COUNT(*) FROM knowledge_character_index"
        ).fetchone()[0]
        assert index_count > 0

    def test_rowids_follow_file_order(self, seeded: KnowledgeStore) -> None:
        rows = seeded.database.execute(
            "SELECT rowid, id FROM knowledge_fts ORDER BY rowid"
        ).fetchall()
        assert [(row["rowid"], row["id"]) for row in rows] == [(1, "k1"), (2, "k2")]

    def test_character_index_excludes_body_and_source(self, seeded: KnowledgeStore) -> None:
        characters = {
            row[0]
            for row in seeded.database.execute(
                "SELECT character FROM knowledge_character_index WHERE record_rowid = 1"
            )
        }
        assert "装" in characters  # 来自 title/tags
        assert "洗" not in characters  # 只出现在 body
        assert "f" not in characters  # 只出现在 source（faq#suit）


class TestSearchGuards:
    def test_empty_and_whitespace_query(self, seeded: KnowledgeStore) -> None:
        for query in ("", "   \t "):
            result = seeded.search(query, limit=5)
            assert result.status == "ok"
            assert result.query == query  # 原样回显
            assert result.results == []
            assert result.error is None

    def test_query_too_long(self, seeded: KnowledgeStore) -> None:
        result = seeded.search("装" * 501, limit=5)
        assert result.status == "error"
        assert result.error == "invalid_knowledge_query"
        assert result.results == []
        assert seeded.search("装" * 500, limit=5).error != "invalid_knowledge_query"

    def test_normalization_collapses_whitespace(self, seeded: KnowledgeStore) -> None:
        raw = "  西装   租赁  "
        result = seeded.search(raw, limit=5)
        assert result.query == raw
        assert [item.id for item in result.results] == ["k1"]


class TestThreeTierSearch:
    def test_fts_trigram_tier(self, seeded: KnowledgeStore) -> None:
        result = seeded.search("西装租赁", limit=5)
        assert result.status == "ok"
        assert [item.id for item in result.results] == ["k1"]
        top = result.results[0]
        assert top.title == "婚礼西装租赁指南"
        assert top.tags == ["西装", "租赁"]

    def test_short_term_tier_for_sub_trigram_terms(self, seeded: KnowledgeStore) -> None:
        # "XL" 长度 2：无 trigram fragment，落到 LIKE 层
        assert [item.id for item in seeded.search("XL", limit=5).results] == ["k2"]
        # 中文双字词同理
        assert [item.id for item in seeded.search("衬衫", limit=5).results] == ["k2"]

    def test_short_term_tier_orders_by_match_count(self, seeded: KnowledgeStore) -> None:
        # k2 命中 [衬衫, XL] 两词，k1 一词不中；"西装" 只有 k1 命中
        results = seeded.search("衬衫 XL", limit=5).results
        assert [item.id for item in results] == ["k2"]
        mixed = seeded.search("西装 尺码", limit=5).results
        # 各命中一词 → match_count 并列 → rowid 升序
        assert [item.id for item in mixed] == ["k1", "k2"]

    def test_fuzzy_tier_edit_distance(self, seeded: KnowledgeStore) -> None:
        # "西裝"（繁体 裝）：LIKE 不中；字符索引召回 西 → 编辑距离 1 命中 k1
        result = seeded.search("西裝", limit=5)
        assert result.status == "ok"
        assert [item.id for item in result.results] == ["k1"]

    def test_fuzzy_tier_no_shared_characters(self, seeded: KnowledgeStore) -> None:
        result = seeded.search("qq", limit=5)
        assert result.status == "ok"
        assert result.results == []

    def test_limit_clamped_to_ten_and_floor_one(
        self, store: KnowledgeStore, tmp_path: Path
    ) -> None:
        records = [
            record(
                f"k{index:02d}",
                title=f"西装护理知识{index:02d}",
                summary="日常护理",
                body="通用内容。",
                tags=[],
            )
            for index in range(1, 13)
        ]
        write_jsonl(tmp_path / "many.jsonl", records)
        store.import_jsonl(tmp_path / "many.jsonl")
        capped = store.search("西装护理", limit=50)
        assert [item.id for item in capped.results] == [f"k{i:02d}" for i in range(1, 11)]
        floored = store.search("西装护理", limit=0)
        assert [item.id for item in floored.results] == ["k01"]


class TestCatchAllDegradation:
    def test_corrupt_row_returns_unavailable(self, seeded: KnowledgeStore) -> None:
        # tags 损坏为非 JSON：行→记录转换抛错也要降级（TS catch-all，非仅 sqlite3.Error）
        seeded.database.execute("UPDATE knowledge_fts SET tags = 'not-json' WHERE rowid = 1")
        result = seeded.search("西装租赁", limit=5)
        assert result.status == "error"
        assert result.error == "knowledge_search_unavailable"
        assert result.results == []

    def test_closed_connection_returns_unavailable(
        self, seeded: KnowledgeStore
    ) -> None:
        seeded.database.close()
        result = seeded.search("西装租赁", limit=5)
        assert result.status == "error"
        assert result.error == "knowledge_search_unavailable"


class TestSharedConnectionWithCommerce:
    def test_reuses_commerce_connection(self, tmp_path: Path) -> None:
        from chatty.commerce import CommerceStore

        commerce = CommerceStore(tmp_path / "chatty.sqlite")
        store = KnowledgeStore(commerce.database)
        source = write_jsonl(tmp_path / "knowledge.jsonl", [record("k1")])
        assert store.import_jsonl(source) == 1
        assert [item.id for item in store.search("西装租赁", limit=5).results] == ["k1"]
        # 同一连接上 commerce 事务照常工作（无嵌套事务冲突）
        availability = commerce.check_availability(
            product_id="SUIT-001", size="M", quantity=1, fulfillment_mode="buyout"
        )
        assert availability.available
        commerce.close()
