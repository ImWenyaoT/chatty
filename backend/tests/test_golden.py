"""跨语言 parity 基线。

Python 与 TypeScript 后端读同一份 `tests/golden/data-layer.cases.json`，输出必须与
`data-layer.expected.json` 完全一致。迁移期间它是判断两套实现是否等价的唯一依据。

重新生成基线：GOLDEN_UPDATE=1 pnpm test
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from app.agent.evidence import RecommendationEvidence, validate_tool_sequence
from app.agent.framing import (
    TaskFrameParseError,
    TaskFrameWire,
    describe_task_frame,
    parse_task_frame,
    product_context,
)
from app.agent.workflow import allowed_tools, plan_tool_batch, render_agent_status
from app.data.catalog import Catalog, CatalogError
from app.data.database import DATA_DIR, segment_for_index, split_into_chunks
from app.data.models import (
    ProductNeed,
    RecommendationDraftItem,
    RecommendationRequest,
    TaskFrame,
    UserContext,
)

GOLDEN_DIR = Path(__file__).resolve().parents[2] / "tests" / "golden"
CASES_PATH = GOLDEN_DIR / "data-layer.cases.json"
EXPECTED_PATH = GOLDEN_DIR / "data-layer.expected.json"


@pytest.fixture(scope="module")
def catalog():
    instance = Catalog(database_path=":memory:", data_dir=DATA_DIR)
    try:
        yield instance
    finally:
        instance.close()


def _evidence(spec: dict[str, Any]) -> RecommendationEvidence:
    evidence = RecommendationEvidence()
    evidence.used_tools = list(spec.get("used_tools", []))
    evidence.blocked_attempts = list(spec.get("blocked_attempts", []))
    evidence.completed_knowledge_scopes = set(
        spec.get("completed_knowledge_scopes", [])
    )
    evidence.required_knowledge_scopes = tuple(
        spec.get("required_knowledge_scopes", [])
    )
    if "required_support_tools" in spec:
        evidence.required_support_tools = tuple(spec["required_support_tools"])
    return evidence


def _run(case: dict[str, Any], catalog: Catalog) -> Any:
    op = case["op"]
    data = case["input"]

    if op == "segment_for_index":
        return segment_for_index(data["text"])
    if op == "split_into_chunks":
        return split_into_chunks(data["text"], data["target"], data["overlap"])
    if op == "rewrite_query":
        return catalog._rewrite_query(data["query"])
    if op == "match_expression":
        return catalog._match_expression(data["query"])

    if op == "user_profile":
        profile = catalog.user_profile(
            data["user_id"], UserContext(**data["overrides"])
        )
        return profile.model_dump()
    if op == "search":
        profile = catalog.user_profile(
            data["user_id"], UserContext(**data["overrides"])
        )
        products = catalog.search(
            profile=profile,
            categories=data["categories"],
            min_price_cents=profile.min_price_cents,
            max_price_cents=profile.max_price_cents,
            limit=data["limit"],
        )
        return [product.product_id for product in products]
    if op == "score":
        profile = catalog.user_profile(data["user_id"])
        by_id = {product.product_id: product for product in catalog.products}
        return {pid: catalog._score(by_id[pid], profile) for pid in data["product_ids"]}
    if op == "inventory":
        return [
            product.product_id for product in catalog.inventory(data["product_ids"])
        ]
    if op == "retrieve_knowledge":
        hits = catalog.retrieve_knowledge(
            query=data["query"],
            categories=data["categories"],
            product_ids=data["product_ids"],
            limit=data["limit"],
        )
        return [
            {
                "doc_id": hit.doc_id,
                "chunk_ordinal": hit.chunk_ordinal,
                "category": hit.category,
                "product_id": hit.product_id,
                "relevance_score": hit.relevance_score,
            }
            for hit in hits
        ]
    if op == "marketing_strategy":
        return {
            segment: catalog.marketing_strategy(segment).model_dump()
            for segment in data["segments"]
        }
    if op == "finalize":
        context = UserContext(**data["overrides"])
        request = RecommendationRequest(
            user_id=data["user_id"],
            num_items=data["num_items"],
            context=context,
        )
        profile = catalog.user_profile(request.user_id, context)
        draft = [RecommendationDraftItem(**item) for item in data["draft"]]
        return [item.model_dump() for item in catalog.finalize(draft, request, profile)]

    if op == "parse_task_frame":
        frame = parse_task_frame(TaskFrameWire(**data["wire"]), catalog.categories)
        return frame.model_dump()
    if op == "product_context":
        return product_context(ProductNeed(**data["need"])).model_dump()
    if op == "describe_task_frame":
        need = data["frame"]["product_need"]
        return describe_task_frame(
            TaskFrame(
                product_need=None if need is None else ProductNeed(**need),
                knowledge_query=data["frame"]["knowledge_query"],
            )
        )

    if op == "validate_tool_sequence":
        return validate_tool_sequence(data["used_tools"])
    if op == "workflow_state":
        evidence = _evidence(data["evidence"])
        return {
            "allowed_next": list(allowed_tools(evidence)),
            "agent_status": render_agent_status(evidence),
        }
    if op == "plan_tool_batch":
        evidence = _evidence(data["evidence"])
        calls = [(call_id, name) for call_id, name in data["calls"]]
        batch = plan_tool_batch(evidence, calls)
        return {
            "stage": batch.stage.value,
            "decisions": {
                call_id: {"allowed": decision.allowed, "reason": decision.reason}
                for call_id, decision in batch.decisions.items()
            },
        }

    raise AssertionError(f"unknown golden op: {op}")


def _outcome(case: dict[str, Any], catalog: Catalog) -> Any:
    try:
        return {"ok": _run(case, catalog)}
    except (CatalogError, TaskFrameParseError) as error:
        return {"error": str(error)}


def test_data_layer_matches_the_golden_baseline(catalog: Catalog) -> None:
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))["cases"]
    actual = {
        f"{case['op']}::{case['name']}": _outcome(case, catalog) for case in cases
    }

    if os.environ.get("GOLDEN_UPDATE"):
        EXPECTED_PATH.write_text(
            json.dumps(actual, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    expected = json.loads(EXPECTED_PATH.read_text(encoding="utf-8"))
    assert actual == expected
