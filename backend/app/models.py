"""Chatty 业务对象。

模型只描述数据形状，不包含数据库查询或 Agent 流程。
"""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

UserSegment = Literal[
    "new_user",
    "active",
    "high_value",
    "price_sensitive",
    "churn_risk",
]
USER_SEGMENTS: tuple[UserSegment, ...] = (
    "new_user",
    "active",
    "high_value",
    "price_sensitive",
    "churn_risk",
)


class Product(BaseModel):
    product_id: str
    name: str
    category: str
    price_cents: int
    description: str
    brand: str
    seller_id: str
    stock: int
    tags: list[str]
    popularity_score: float
    image_url: str
    source: str


class UserContext(BaseModel):
    recent_views: list[str] | None = None
    recent_purchases: list[str] | None = None
    preferred_categories: list[str] | None = None
    min_price_cents: int | None = None
    max_price_cents: int | None = None


class UserProfile(BaseModel):
    user_id: str
    segment: UserSegment
    preferred_categories: list[str]
    min_price_cents: int
    max_price_cents: int
    recent_views: list[str]
    recent_purchases: list[str]


class KnowledgeDocument(BaseModel):
    doc_id: str
    title: str
    content: str
    category: str
    product_id: str | None
    source: str


class KnowledgeHit(KnowledgeDocument):
    chunk_ordinal: int
    relevance_score: float


class MarketingStrategy(BaseModel):
    segment: UserSegment
    tone: str
    instructions: str
    forbidden_words: list[str]


class RecommendationDraftItem(BaseModel):
    product_id: str
    reason: str
    marketing_copy: str


class RecommendationRequest(BaseModel):
    user_id: str
    num_items: int = Field(default=5, ge=1, le=10)
    context: UserContext = Field(default_factory=UserContext)


class RecommendedProduct(BaseModel):
    product_id: str
    name: str
    category: str
    price_cents: int
    brand: str
    stock: int
    tags: list[str]
    low_stock: bool
    reason: str
    marketing_copy: str


class AgentDraft(BaseModel):
    """模型生成的草稿；Harness 仍会在之后验证其中的商品。"""

    action: Literal["clarify", "recommend"]
    question: str | None = None
    recommendations: list[RecommendationDraftItem] | None = None

    @model_validator(mode="after")
    def action_payload_must_match(self) -> "AgentDraft":
        if self.action == "clarify":
            if not self.question or not self.question.strip():
                raise ValueError("clarify_question_required")
            if self.recommendations:
                raise ValueError("clarify_must_not_recommend")
        if self.action == "recommend":
            if not self.recommendations:
                raise ValueError("recommendations_required")
            if self.question:
                raise ValueError("recommend_must_not_ask_question")
        return self


class RecommendationResponse(BaseModel):
    products: list[RecommendedProduct]
    total_latency_ms: float


class ClarifyReply(BaseModel):
    question: str
    total_latency_ms: float


Reply = RecommendationResponse | ClarifyReply
