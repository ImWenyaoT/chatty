import json
from pathlib import Path

import pytest

from chatty.knowledge import KnowledgeStore


def write_knowledge(path: Path) -> None:
    records = [
        {
            "id": "policy-exchange-1",
            "title": "尺码不合适可以换吗",
            "summary": "符合条件时可免费换码一次。",
            "body": "商家发错尺码可免费补发；按推荐尺码仍不合身，可协助更换一次。",
            "source": "seller-policy://exchange",
            "tags": ["售后", "换码"],
        },
        {
            "id": "policy-rental-period-1",
            "title": "租期计算",
            "summary": "租期从签收当天开始。",
            "body": "租期从签收当天开始计算，到约定归还日期寄回即可。",
            "source": "seller-policy://rental-period",
        },
        {
            "id": "product-suit-001-1",
            "title": "面试西装",
            "summary": "黑色西装适合面试。",
            "body": "SUIT-001 黑色双排扣西装适合面试和婚礼。",
            "source": "seller-catalog://SUIT-001",
            "tags": ["商品"],
        },
    ]
    path.write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records),
        encoding="utf-8",
    )


def test_seller_can_import_jsonl_and_search_structured_knowledge(tmp_path: Path) -> None:
    source = tmp_path / "knowledge.jsonl"
    write_knowledge(source)
    store = KnowledgeStore(tmp_path / "chatty.sqlite")

    assert store.import_jsonl(source) == 3
    result = store.search("租期", limit=3)

    assert result.status == "ok"
    assert result.query == "租期"
    assert [hit.model_dump() for hit in result.results] == [
        {
            "id": "policy-rental-period-1",
            "title": "租期计算",
            "summary": "租期从签收当天开始。",
            "body": "租期从签收当天开始计算，到约定归还日期寄回即可。",
            "source": "seller-policy://rental-period",
            "tags": [],
        }
    ]


def test_customer_can_search_multiple_chinese_short_terms(tmp_path: Path) -> None:
    source = tmp_path / "knowledge.jsonl"
    write_knowledge(source)
    store = KnowledgeStore(tmp_path / "chatty.sqlite")
    store.import_jsonl(source)

    result = store.search("面试 西装", limit=1)

    assert result.status == "ok"
    assert result.results[0].id == "product-suit-001-1"


def test_customer_can_search_with_a_small_typo(tmp_path: Path) -> None:
    source = tmp_path / "knowledge.jsonl"
    write_knowledge(source)
    store = KnowledgeStore(tmp_path / "chatty.sqlite")
    store.import_jsonl(source)

    result = store.search("租其", limit=1)

    assert result.status == "ok"
    assert result.results[0].id == "policy-rental-period-1"


def test_customer_receives_an_empty_result_for_unrelated_knowledge(tmp_path: Path) -> None:
    source = tmp_path / "knowledge.jsonl"
    write_knowledge(source)
    store = KnowledgeStore(tmp_path / "chatty.sqlite")
    store.import_jsonl(source)

    result = store.search("量子计算机", limit=3)

    assert result.status == "ok"
    assert result.results == []


def test_invalid_jsonl_is_reported_without_replacing_the_current_index(tmp_path: Path) -> None:
    valid = tmp_path / "valid.jsonl"
    invalid = tmp_path / "invalid.jsonl"
    write_knowledge(valid)
    invalid.write_text('{"id":"missing-fields"}\n', encoding="utf-8")
    store = KnowledgeStore(tmp_path / "chatty.sqlite")
    store.import_jsonl(valid)

    with pytest.raises(ValueError, match="invalid knowledge record on line 1"):
        store.import_jsonl(invalid)

    assert store.search("租期", limit=3).results[0].id == "policy-rental-period-1"


def test_search_failure_is_a_structured_external_result(tmp_path: Path) -> None:
    store = KnowledgeStore(tmp_path / "chatty.sqlite")
    (tmp_path / "chatty.sqlite").unlink()
    (tmp_path / "chatty.sqlite").mkdir()

    result = store.search("租期", limit=3)

    assert result.status == "error"
    assert result.results == []
    assert result.error == "knowledge_search_unavailable"


def test_oversized_query_is_rejected_at_the_store_boundary(tmp_path: Path) -> None:
    store = KnowledgeStore(tmp_path / "chatty.sqlite")

    result = store.search("长" * 501, limit=3)

    assert result.status == "error"
    assert result.error == "invalid_knowledge_query"
