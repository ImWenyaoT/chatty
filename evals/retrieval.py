"""检索质量评估。

对应《深入理解 AI Agent》第 3.2 节"如何度量检索质量"，实现表 3-3 里的两个核心指标。

为什么要单独测检索：端到端评估只能告诉你"这次推荐失败了"，
但失败可能来自检索没召回、模型没用好检索结果、或者 Harness 校验拦下了。
把检索单独拎出来度量，才能定位到底是哪一层的问题——
`knowledge_not_retrieved` 正是端到端评估里出现过的失败之一。

**指标口径必须写清楚**（教材脚注特别强调过这点）：

- `recall@k` —— 本模块采用教材口径，即**命中率**（hit rate / success@k）：
  前 k 个结果里只要有一篇标注为相关的文档就算命中，统计的是**查询的比例**。
  学术上标准的 recall@k 是"召回的相关文档数 ÷ 该查询全部相关文档数"，两者在
  一个查询有多篇相关文档时并不相等。跨来源比较数字时务必先对齐定义。
- `MRR` —— 每个查询取第一篇相关文档排名的倒数（排第 1 得 1，排第 10 得 0.1），再对所有查询平均。

教材表 3-3 还给了第三个指标 nDCG，这里**没有实现**：它需要为每篇文档人工标注
分级相关性（"高度相关"还是"沾边"），标注成本明显高于前两个指标，
而 recall@k 加 MRR 已经能回答"该找的找到没有"和"找到得够不够靠前"这两个核心问题。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from chatty.catalog import Catalog


@dataclass(frozen=True)
class RetrievalCase:
    """一条带标注的检索测试用例。

    query 模拟模型在真实推荐流程里会发出的检索请求，
    relevant_docs 是人工标注的"标准答案"——没有标注就无法计算任何指标。
    """

    case_id: str
    query: str
    categories: list[str] = field(default_factory=list)
    product_ids: list[str] = field(default_factory=list)
    relevant_docs: frozenset[str] = frozenset()  # 标注为相关的文档 ID
    note: str = ""


# ============================================================================
# 标注集。覆盖三类查询，正好对应稀疏检索的强项与弱项：
#   A. 词面直接命中 —— BM25 的强项
#   B. 同义/近义表达 —— BM25 的天然弱项。这几条靠同义词表兜住了，
#      但词表是穷举的：没收录的说法照样漏，这才是真正的边界
#   C. 跨类目通用查询 —— 检验过滤条件是否正确收窄范围
# ============================================================================

RETRIEVAL_CASES: tuple[RetrievalCase, ...] = (
    # ── A. 词面直接命中 ──
    RetrievalCase(
        case_id="R01-earphone-anc",
        query="降噪 耳机 通勤",
        categories=["耳机"],
        product_ids=["P003", "P004"],
        relevant_docs=frozenset({"K001", "K002", "K003"}),
        note="三篇耳机文档都含'降噪'，标准的词面匹配场景",
    ),
    RetrievalCase(
        case_id="R02-coffee-machine",
        query="咖啡机 胶囊",
        categories=["家电"],
        product_ids=["P018"],
        relevant_docs=frozenset({"K030", "K009"}),
        note="商品专属文档应排在通用选购原则之前",
    ),
    RetrievalCase(
        case_id="R03-tablet-study",
        query="平板 学习 办公",
        categories=["平板"],
        product_ids=["P005", "P006"],
        relevant_docs=frozenset({"K005", "K020", "K021"}),
    ),
    RetrievalCase(
        case_id="R04-laptop",
        query="笔记本 轻薄 办公",
        categories=["电脑"],
        product_ids=["P030"],
        relevant_docs=frozenset({"K013", "K022"}),
    ),
    RetrievalCase(
        case_id="R05-running-shoes",
        query="跑鞋 竞速 训练",
        categories=["运动"],
        product_ids=["P040", "P016"],
        relevant_docs=frozenset({"K027", "K007"}),
    ),
    # ── B. 同义表达（BM25 认字面不认语义，靠 query_synonyms.json 桥接）──
    RetrievalCase(
        case_id="R06-synonym-quiet",
        query="安静 静音 耳机",
        categories=["耳机"],
        product_ids=["P003", "P004"],
        relevant_docs=frozenset({"K001", "K002", "K003"}),
        note="'静音'与文档里的'降噪'是同义表达，BM25 只认字面，靠同义词表桥接",
    ),
    RetrievalCase(
        case_id="R07-synonym-eyecare",
        query="保护视力 不伤眼",
        categories=["家电"],
        product_ids=["P019"],
        relevant_docs=frozenset({"K031"}),
        note="文档写'护眼'，查询用'保护视力'——同义词表把两者对上",
    ),
    RetrievalCase(
        case_id="R08-synonym-battery",
        query="电池耐用 一天一充",
        categories=["穿戴"],
        product_ids=["P031", "P032"],
        relevant_docs=frozenset({"K015", "K024"}),
        note="文档写'长续航'，查询用'电池耐用'——同上，靠词表桥接",
    ),
    # ── C. 过滤条件是否正确收窄 ──
    RetrievalCase(
        case_id="R09-scope-accessory",
        query="快充 充电器",
        categories=["配件"],
        product_ids=["P007"],
        relevant_docs=frozenset({"K006", "K036"}),
        note="类目过滤应把手机类的快充内容排除在外",
    ),
    RetrievalCase(
        case_id="R10-marketing-guidance",
        query="价格敏感 沟通 原则",
        categories=["营销"],
        relevant_docs=frozenset({"K010"}),
        note="营销类知识不绑定商品，product_ids 为空时应能命中",
    ),
)


@dataclass
class RetrievalMetrics:
    """一次检索评估的汇总指标。"""

    k: int
    cases: int
    recall_at_k: float  # 教材口径：命中率
    mrr: float
    misses: list[str] = field(default_factory=list)  # 完全没召回的用例


def evaluate_retrieval(
    cases: tuple[RetrievalCase, ...] = RETRIEVAL_CASES,
    *,
    k: int = 5,
    data_dir: Path | None = None,
) -> RetrievalMetrics:
    """在标注集上跑一遍检索，计算两个指标。

    不需要模型，纯粹是检索层的度量，所以零成本、完全确定。
    """
    catalog = Catalog(data_dir)
    try:
        hits = 0
        reciprocal_ranks: list[float] = []
        misses: list[str] = []

        for case in cases:
            results = catalog.retrieve_knowledge(
                case.query,
                categories=case.categories,
                product_ids=case.product_ids,
                limit=k,
            )
            retrieved_ids = [hit.doc_id for hit in results]

            # 前 k 个结果里，哪些位置上的文档被标注为相关
            relevant_positions = [
                rank
                for rank, doc_id in enumerate(retrieved_ids)
                if doc_id in case.relevant_docs
            ]
            if relevant_positions:
                # recall@k（教材口径）：只要有一篇相关就算这条查询命中
                hits += 1
                # MRR：第一篇相关文档排名的倒数（rank 从 0 开始，所以 +1）
                reciprocal_ranks.append(1 / (relevant_positions[0] + 1))
            else:
                reciprocal_ranks.append(0.0)
                misses.append(case.case_id)

        total = len(cases)
        return RetrievalMetrics(
            k=k,
            cases=total,
            recall_at_k=round(hits / total, 4) if total else 0.0,
            mrr=round(sum(reciprocal_ranks) / total, 4) if total else 0.0,
            misses=misses,
        )
    finally:
        catalog.close()


def render_retrieval_report(metrics: RetrievalMetrics) -> str:
    lines = [
        f"检索质量（{metrics.cases} 条标注查询，k={metrics.k}）",
        f"  recall@{metrics.k}（命中率口径）：{metrics.recall_at_k:.0%}",
        f"  MRR：                {metrics.mrr:.4f}",
    ]
    if metrics.misses:
        lines += ["", f"完全未召回的查询（{len(metrics.misses)} 条）："]
        case_by_id = {case.case_id: case for case in RETRIEVAL_CASES}
        for case_id in metrics.misses:
            case = case_by_id[case_id]
            lines.append(f"  {case_id}  query='{case.query}'")
            if case.note:
                lines.append(f"      {case.note}")
    return "\n".join(lines)
