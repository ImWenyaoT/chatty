from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

UserSegment = Literal[
    "new_user",
    "active",
    "high_value",
    "price_sensitive",
    "churn_risk",
]


class StrictModel(BaseModel):
    """拒绝未知字段，避免请求或模型输出中的拼写错误被静默忽略。"""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Product(StrictModel):
    product_id: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=120)
    category: str = Field(min_length=1, max_length=40)
    price_cents: int = Field(gt=0)
    description: str = Field(default="", max_length=500)
    brand: str = Field(default="", max_length=80)
    seller_id: str = Field(default="", max_length=40)
    stock: int = Field(ge=0)
    tags: list[str] = Field(default_factory=list, max_length=20)
    popularity_score: float = Field(ge=0, le=1)
    image_url: str = Field(default="", max_length=500)
    source: str = Field(min_length=1, max_length=120)


class UserContext(StrictModel):
    recent_views: list[str] = Field(default_factory=list, max_length=30)
    recent_purchases: list[str] = Field(default_factory=list, max_length=30)
    preferred_categories: list[str] = Field(default_factory=list, max_length=20)
    min_price_cents: int | None = Field(default=None, ge=0)
    max_price_cents: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def valid_price_range(self) -> UserContext:
        if (
            self.min_price_cents is not None
            and self.max_price_cents is not None
            and self.min_price_cents > self.max_price_cents
        ):
            raise ValueError("min_price_cents must not exceed max_price_cents")
        return self


class RecommendationRequest(StrictModel):
    user_id: str = Field(min_length=1, max_length=64)
    num_items: int = Field(default=5, ge=1, le=10)
    context: UserContext = Field(default_factory=UserContext)


class UserProfile(StrictModel):
    user_id: str
    segment: UserSegment
    preferred_categories: list[str] = Field(default_factory=list)
    min_price_cents: int = Field(ge=0)
    max_price_cents: int = Field(gt=0)
    recent_views: list[str] = Field(default_factory=list)
    recent_purchases: list[str] = Field(default_factory=list)


class KnowledgeDocument(StrictModel):
    doc_id: str
    title: str
    content: str
    category: str
    product_id: str | None = None
    source: str


class KnowledgeHit(KnowledgeDocument):
    """一条检索命中。

    注意 content 是**命中的那个块**，不是整篇文档——长文档会被切成多块分别索引，
    检索命中哪块就返回哪块。chunk_ordinal 是块在原文中的序号（从 0 开始），
    配合 doc_id 可以追溯回完整原文。
    """

    chunk_ordinal: int = Field(ge=0, default=0)
    relevance_score: float = Field(ge=0, le=1)


class MarketingStrategy(StrictModel):
    segment: UserSegment
    tone: str
    instructions: str
    forbidden_words: list[str]


class RecommendationDraftItem(StrictModel):
    product_id: str = Field(min_length=1, max_length=40)
    reason: str = Field(min_length=1, max_length=300)
    marketing_copy: str = Field(min_length=1, max_length=500)


class AgentDraft(StrictModel):
    """模型每一轮的输出：要么反问澄清，要么给推荐。

    多轮场景下用户不会一次把需求说全（"想买个耳机"没说预算和场景），
    Agent 得先问清楚再推荐。单轮场景下模型直接给 recommend，字段完全兼容。
    """

    action: Literal["clarify", "recommend"] = "recommend"
    # action=clarify 时用：要反问的那句话
    question: str | None = Field(default=None, max_length=200)
    # action=recommend 时用：推荐的商品
    recommendations: list[RecommendationDraftItem] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def payload_matches_action(self) -> AgentDraft:
        if self.action == "clarify" and not self.question:
            raise ValueError("clarify 必须给出 question")
        if self.action == "recommend" and not self.recommendations:
            raise ValueError("recommend 必须给出 recommendations")
        return self


class ClarifyReply(StrictModel):
    """Agent 这一轮没给推荐，而是反问了一句。"""

    request_id: str
    user_id: str
    question: str
    total_latency_ms: float = Field(ge=0)


class RecommendedProduct(StrictModel):
    product_id: str
    name: str
    category: str
    price_cents: int
    brand: str
    stock: int
    tags: list[str]
    score: float = Field(ge=0, le=1)
    low_stock: bool
    reason: str = Field(min_length=1, max_length=300)
    marketing_copy: str = Field(min_length=1, max_length=500)


class RecommendationResponse(StrictModel):
    request_id: str
    user_id: str
    products: list[RecommendedProduct]
    total_latency_ms: float = Field(ge=0)

