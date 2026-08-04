from __future__ import annotations

import json
from dataclasses import dataclass

from app.data.catalog import Catalog


@dataclass(frozen=True)
class RetrievalCase:
    query: str
    categories: list[str]
    product_ids: list[str]
    relevant_document_ids: set[str]


CASES = [
    RetrievalCase(
        "降噪 耳机 通勤", ["耳机"], ["P003", "P004"], {"K001", "K002", "K003"}
    ),
    RetrievalCase("咖啡机 胶囊", ["家电"], ["P018"], {"K030", "K009"}),
    RetrievalCase(
        "平板 学习 办公", ["平板"], ["P005", "P006"], {"K005", "K020", "K021"}
    ),
    RetrievalCase("笔记本 轻薄 办公", ["电脑"], ["P030"], {"K013", "K022"}),
    RetrievalCase("跑鞋 竞速 训练", ["运动"], ["P040", "P016"], {"K027", "K007"}),
    RetrievalCase(
        "安静 静音 耳机", ["耳机"], ["P003", "P004"], {"K001", "K002", "K003"}
    ),
    RetrievalCase("保护视力 不伤眼", ["家电"], ["P019"], {"K031"}),
    RetrievalCase("电池耐用 一天一充", ["穿戴"], ["P031", "P032"], {"K015", "K024"}),
    RetrievalCase("快充 充电器", ["配件"], ["P007"], {"K006", "K036"}),
    RetrievalCase("价格敏感 沟通 原则", ["营销"], [], {"K010"}),
]


def evaluate_retrieval(catalog: Catalog) -> dict[str, int | float]:
    hits = 0
    reciprocal_rank_total = 0.0
    for case in CASES:
        document_ids = [
            hit.doc_id
            for hit in catalog.retrieve_knowledge(
                query=case.query,
                categories=case.categories,
                product_ids=case.product_ids,
                limit=5,
            )
        ]
        rank: int | None = None
        for index, doc_id in enumerate(document_ids):
            if doc_id in case.relevant_document_ids:
                rank = index
                break
        if rank is not None:
            hits += 1
            reciprocal_rank_total += 1 / (rank + 1)

    return {
        "cases": len(CASES),
        "hit_rate_at_5": hits / len(CASES),
        "mrr_at_5": round(reciprocal_rank_total / len(CASES), 4),
    }


def main() -> None:
    catalog = Catalog()
    try:
        metrics = evaluate_retrieval(catalog)
    finally:
        catalog.close()

    print(
        json.dumps(
            metrics,
            ensure_ascii=False,
            indent=2,
        )
    )
    if metrics["hit_rate_at_5"] < 1:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
