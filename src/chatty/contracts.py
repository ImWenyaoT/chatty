"""Chatty HTTP 契约的 Pydantic 模型（对应 http-contract.md §2）。

zod 对照约定：`.strict()` → `extra="forbid"`；`.strip()` → `extra="ignore"`；
`.passthrough()` → `extra="allow"`。
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

ArtifactStatus = Literal["draft", "review_failed", "review_pending", "approved", "exported"]

RunStatus = Literal["completed", "not_completed", "responded", "needs_human"]

BusinessOutcome = Literal["verified", "not_completed", "not_applicable"]

NonEmptyStr = Annotated[str, Field(min_length=1)]

# business_outcome → 非 handoff run 的对外 status。
_STATUS_BY_OUTCOME: dict[BusinessOutcome, RunStatus] = {
    "verified": "completed",
    "not_completed": "not_completed",
    "not_applicable": "responded",
}


def run_status(
    *, business_outcome: BusinessOutcome, support_request_id: str | None
) -> RunStatus:
    """(business_outcome, handoff 回执) → 对外 status（http-contract §2.6）。

    这条映射只在这里写一次：run 循环用它派生 status，`RunResponse` 的
    model_validator 用它复算并比对——派生方与裁决方不可能再漂移。
    """
    if support_request_id is not None:
        return "needs_human"
    return _STATUS_BY_OUTCOME[business_outcome]


class RunRequest(BaseModel):
    """POST /runs 请求体。未知字段（含伪造的 customer_id/request_id）静默忽略。"""

    model_config = ConfigDict(extra="ignore")

    message: str = Field(min_length=1, max_length=20_000)
    session_id: str | None = Field(default=None, min_length=1, max_length=200)


class KnowledgeRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=500)
    summary: str = Field(min_length=1, max_length=2000)
    body: str = Field(min_length=1, max_length=20_000)
    source: str = Field(min_length=1, max_length=2000)
    tags: list[str] = Field(max_length=20)


class KnowledgeSearchResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["ok", "error"]
    query: str
    results: list[KnowledgeRecord]
    error: Literal["invalid_knowledge_query", "knowledge_search_unavailable"] | None = None


class CustomerMemory(BaseModel):
    model_config = ConfigDict(extra="forbid")

    memory_id: str = Field(min_length=1)
    customer_id: str = Field(min_length=1)
    fact: str
    source_id: str = Field(min_length=1)
    created_at: str


class MemoryEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tool: str
    memories: list[CustomerMemory]


class RunResponse(BaseModel):
    """POST /runs 的 200 响应体（TS 契约中的 CompletedRun）。"""

    model_config = ConfigDict(extra="forbid")

    reply: str
    customer_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    trace_id: str = Field(min_length=1)
    request_id: str = Field(min_length=1)
    status: RunStatus
    business_outcome: BusinessOutcome
    completion_evidence: str | None
    knowledge_search_results: list[KnowledgeRecord]
    memory_events: list[MemoryEvent]
    needs_human: bool
    # JSON 中始终输出（无则为 null）；OpenAPI 中标为非必填。
    support_request_id: str | None = None

    @model_validator(mode="after")
    def _check_outcome_consistency(self) -> RunResponse:
        # 逐条对应 zod superRefine，短路顺序与 TS 一致；status 一律用 run_status 复算。
        if self.status == "needs_human":
            handoff_matches = (
                self.needs_human is True
                and self.business_outcome == "not_completed"
                and self.support_request_id is not None
                and self.completion_evidence == f"handoff:{self.support_request_id}"
            )
            if not handoff_matches:
                raise ValueError("needs_human run must include a matching handoff receipt")
            return self
        if self.needs_human is True or self.support_request_id is not None:
            raise ValueError("non-handoff run cannot include a support request")
        derived = run_status(
            business_outcome=self.business_outcome,
            support_request_id=self.support_request_id,
        )
        if self.status == "completed" and (
            derived != self.status or self.completion_evidence is None
        ):
            raise ValueError("completed run must include verified evidence")
        elif self.status == "not_completed" and (
            derived != self.status or self.completion_evidence is None
        ):
            raise ValueError("not_completed run must include failure evidence")
        elif self.status == "responded" and (
            derived != self.status or self.completion_evidence is not None
        ):
            raise ValueError("responded run cannot claim a business outcome")
        return self


class SessionMessagesResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str = Field(min_length=1)
    messages: list[dict[str, Any]]


class MemorySearchResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    customer_id: str = Field(min_length=1)
    query: str
    memories: list[CustomerMemory]


class ResearchClaim(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    text: str
    source_ids: list[NonEmptyStr] = Field(min_length=1)


class IndustryNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    label: str
    kind: str


class IndustryRelation(BaseModel):
    """`from` 是 Python 保留字：字段名 from_，别名 from，序列化按别名输出。"""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)

    from_: str = Field(alias="from", min_length=1)
    to: str = Field(min_length=1)
    type: str
    claim_id: str = Field(min_length=1)


class ContentChannel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel: Literal["xiaohongshu", "douyin", "wechat"]
    title: str
    body: str
    claim_ids: list[NonEmptyStr] = Field(min_length=1)


class ArtifactBase(BaseModel):
    """两个 artifact 变体的公共基础字段。"""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    owner_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    title: str
    status: ArtifactStatus
    created_at: str
    updated_at: str


class ResearchArtifact(ArtifactBase):
    kind: Literal["research"]
    summary: str
    claims: list[ResearchClaim]
    nodes: list[IndustryNode]
    relations: list[IndustryRelation]
    unknowns: list[str]


class ContentArtifact(ArtifactBase):
    kind: Literal["content"]
    research_artifact_id: str = Field(min_length=1)
    channels: list[ContentChannel] = Field(min_length=1)


Artifact = Annotated[ResearchArtifact | ContentArtifact, Field(discriminator="kind")]
ArtifactList = list[Artifact]


class ArtifactApproval(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    artifact_id: str = Field(min_length=1)
    actor_id: str = Field(min_length=1)
    decision: Literal["approved"]
    created_at: str


class SupportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    customer_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    reason: str
    context: str
    model_context: str
    prior_actions: list[str]
    status: str
    created_at: str
    updated_at: str


class TraceSpan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    span_id: str = Field(min_length=1)
    trace_id: str = Field(min_length=1)
    parent_id: str | None
    span_type: str
    status: str
    summary: str
    started_at: str | None
    ended_at: str | None
    duration_ms: int | None = Field(ge=0)
    error: str | None


class Trace(BaseModel):
    model_config = ConfigDict(extra="forbid")

    trace_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    status: str
    summary: str
    model_id: str
    created_at: str
    updated_at: str
    duration_ms: int = Field(ge=0)
    business_outcome: str | None
    completion_evidence: str | None
    knowledge_sources: list[str]
    memory_sources: list[str]
    support_request_id: str | None
    span_types: list[str]
    # 仅 GET /traces/{id} 填充；列表页恒为 []。
    spans: list[TraceSpan]


class TraceDashboard(BaseModel):
    model_config = ConfigDict(extra="forbid")

    traces: list[Trace]
    order_status_counts: dict[str, Annotated[int, Field(ge=0)]]


class OrderEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    event_type: Literal["created", "confirmed", "cancelled"]
    description: str
    created_at: str


class Order(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    customer_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    product_id: str = Field(min_length=1)
    product_name: str
    size: str
    fulfillment_mode: Literal["rental", "buyout"]
    quantity: int = Field(gt=0)
    start_date: str | None
    end_date: str | None
    amount_cents: int = Field(ge=0)
    status: Literal["pending", "confirmed", "cancelled"]
    channel: str
    address: str
    risk: str
    created_at: str
    updated_at: str
    events: list[OrderEvent]


class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    detail: str | list[Any]
