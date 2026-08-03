"""Harness 用于验证推荐的事实。

Tool Result 有两个消费者：模型获得下一轮推理需要的业务结果；Harness 单独保存
更小的 Evidence，用确定性代码校验事实，而不是相信模型对调用过程的描述。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict

from app.models import KnowledgeHit, RecommendationDraftItem, UserProfile

ToolName = Literal[
    "get_user_profile",
    "search_products",
    "check_inventory",
    "retrieve_knowledge",
    "get_marketing_strategy",
]

TOOL_NAMES: Final[tuple[ToolName, ...]] = (
    "get_user_profile",
    "search_products",
    "check_inventory",
    "retrieve_knowledge",
    "get_marketing_strategy",
)

# 前三个 Tool 构成业务依赖链。知识检索和营销策略只依赖前三步已完成，
# 所以这两个 Tool 可以互换顺序。
DEPENDENCY_CHAIN: Final[tuple[ToolName, ...]] = (
    "get_user_profile",
    "search_products",
    "check_inventory",
)


@dataclass
class RecommendationEvidence:
    """Tool 执行过程中由 Harness 记录、模型看不到的事实。"""

    profile: UserProfile | None = None
    knowledge: list[KnowledgeHit] = field(default_factory=list)
    recalled_product_ids: set[str] = field(default_factory=set)
    in_stock_product_ids: set[str] = field(default_factory=set)
    knowledge_product_ids: set[str] = field(default_factory=set)
    used_tools: list[str] = field(default_factory=list)
    call_log: list[str] = field(default_factory=list)


class EvidenceSnapshot(BaseModel):
    """可序列化的诊断快照；不包含画像详情和知识正文。"""

    model_config = ConfigDict(frozen=True)

    used_tools: list[str]
    profile_segment: str | None = None
    recalled_product_ids: list[str]
    in_stock_product_ids: list[str]
    grounded_product_ids: list[str]
    knowledge_hits: int
    call_log: list[str]


def snapshot_evidence(evidence: RecommendationEvidence) -> EvidenceSnapshot:
    """只复制定位错误需要的字段，避免日志带出整段业务内容。"""

    profile_segment: str | None = None
    if evidence.profile is not None:
        profile_segment = evidence.profile.segment
    return EvidenceSnapshot(
        used_tools=list(evidence.used_tools),
        profile_segment=profile_segment,
        recalled_product_ids=sorted(evidence.recalled_product_ids),
        in_stock_product_ids=sorted(evidence.in_stock_product_ids),
        grounded_product_ids=sorted(evidence.knowledge_product_ids),
        knowledge_hits=len(evidence.knowledge),
        call_log=list(evidence.call_log),
    )


def validate_tool_sequence(used_tools: Sequence[str]) -> str | None:
    """检查 Tool 是否齐全，以及前三个 Tool 的依赖顺序。"""

    expected_tools = set(TOOL_NAMES)
    actual_tools = set(used_tools)

    missing_tools = sorted(expected_tools - actual_tools)
    if missing_tools:
        return f"未调用的工具：{', '.join(missing_tools)}"

    unknown_tools = sorted(actual_tools - expected_tools)
    if unknown_tools:
        return f"调用了未注册的工具：{', '.join(unknown_tools)}"

    for index in range(1, len(DEPENDENCY_CHAIN)):
        previous_tool = DEPENDENCY_CHAIN[index - 1]
        current_tool = DEPENDENCY_CHAIN[index]
        previous_position = used_tools.index(previous_tool)
        current_position = used_tools.index(current_tool)

        if current_position < previous_position:
            chain = " -> ".join(DEPENDENCY_CHAIN)
            return f"依赖顺序错误，应为 {chain}"

    return None


def guard_repeated_call(
    evidence: RecommendationEvidence,
    tool_name: str,
    signature: str,
) -> None:
    """同一参数最多调用三次，防止模型陷入没有进展的循环。"""

    call = f"{tool_name}({signature})"
    evidence.call_log.append(call)

    repeated_calls = evidence.call_log.count(call)
    if repeated_calls > 3:
        raise RuntimeError(
            f"相同参数调用 {tool_name} 已达 3 次，请改变参数后重试或使用现有结果"
        )


def record_search(
    evidence: RecommendationEvidence,
    product_ids: Sequence[str],
) -> None:
    """记录商品搜索真正返回过的商品 ID。"""

    evidence.recalled_product_ids.update(product_ids)
    evidence.used_tools.append("search_products")


def record_inventory(
    evidence: RecommendationEvidence,
    product_ids: Sequence[str],
) -> None:
    """记录已经确认有库存的商品 ID。"""

    evidence.in_stock_product_ids.update(product_ids)
    evidence.used_tools.append("check_inventory")


def record_knowledge(
    evidence: RecommendationEvidence,
    hits: Sequence[KnowledgeHit],
    grounded_product_ids: Sequence[str],
) -> None:
    """记录检索命中，以及这些知识能够支撑的商品 ID。"""

    evidence.knowledge.extend(hits)
    evidence.knowledge_product_ids.update(grounded_product_ids)
    evidence.used_tools.append("retrieve_knowledge")


class EvidenceError(Exception):
    """推荐没有通过 Harness 的确定性 Evidence 校验。"""

    def __init__(
        self, code: str, missing: Sequence[str] = (), detail: str | None = None
    ) -> None:
        super().__init__(code)
        self.code = code
        self.missing = list(missing)
        self.detail = detail


def validate_recommendation_evidence(
    evidence: RecommendationEvidence,
    draft: Sequence[RecommendationDraftItem],
) -> None:
    """要求每个推荐商品都通过召回、库存、知识三组事实校验。"""

    sequence_error = validate_tool_sequence(evidence.used_tools)
    if sequence_error:
        raise EvidenceError("required_tools_not_used", detail=sequence_error)

    if not evidence.knowledge:
        raise EvidenceError("knowledge_not_retrieved")

    if evidence.profile is None:
        raise EvidenceError("profile_not_loaded")

    recommended_product_ids = {item.product_id for item in draft}
    checks = (
        ("product_not_recalled", evidence.recalled_product_ids),
        ("inventory_not_checked", evidence.in_stock_product_ids),
        ("product_not_grounded", evidence.knowledge_product_ids),
    )

    # 这里比较的是集合包含关系：模型推荐的每个 ID，都必须出现在
    # Harness 自己记录的事实集合里。
    for error_code, verified_product_ids in checks:
        missing_product_ids = sorted(recommended_product_ids - verified_product_ids)
        if missing_product_ids:
            raise EvidenceError(error_code, missing_product_ids)


def validate_clarification_evidence(evidence: RecommendationEvidence) -> None:
    """澄清可以没有候选商品，但仍必须完成五个 Tool。"""

    sequence_error = validate_tool_sequence(evidence.used_tools)
    if sequence_error:
        raise EvidenceError("required_tools_not_used", detail=sequence_error)

    if evidence.in_stock_product_ids:
        raise EvidenceError("invalid_recommendation")
