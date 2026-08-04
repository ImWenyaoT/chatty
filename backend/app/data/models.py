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


class ProductNeed(BaseModel):
    """用户明确表达的商品约束；字段为空仍表示用户正在找商品。"""

    category: str | None = None
    min_yuan: float | None = Field(default=None, ge=0)
    max_yuan: float | None = Field(default=None, ge=0)


class TaskFrame(BaseModel):
    """Harness 使用的领域形状；不直接作为 provider structured output。"""

    product_need: ProductNeed | None = None
    knowledge_query: str | None = None

    @model_validator(mode="after")
    def at_least_one_context_is_required(self) -> "TaskFrame":
        if self.product_need is None and not (self.knowledge_query or "").strip():
            raise ValueError("empty_task_frame")
        if self.knowledge_query is not None:
            self.knowledge_query = self.knowledge_query.strip() or None
        return self


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


class RecommendationContext(BaseModel):
    """Harness 在进入 Model 前确定的画像、候选商品和在售商品。"""

    request: RecommendationRequest
    profile: UserProfile
    candidates: list[Product]
    inventory: list[Product]


class TaskContext(BaseModel):
    """进入主 Agent Loop 前已经准备好的全部业务 Context。"""

    frame: TaskFrame
    recommendation: RecommendationContext | None = None


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

    action: Literal["answer", "clarify", "recommend"]
    answer: str | None = None
    question: str | None = None
    recommendations: list[RecommendationDraftItem] | None = None

    @model_validator(mode="after")
    def action_payload_must_match(self) -> "AgentDraft":
        if self.action == "answer":
            if not self.answer or not self.answer.strip():
                raise ValueError("answer_required")
            if self.question or self.recommendations:
                raise ValueError("answer_must_not_include_product_payload")
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
    answer: str | None = None


class ClarifyReply(BaseModel):
    question: str
    answer: str | None = None


class KnowledgeReply(BaseModel):
    answer: str


Reply = RecommendationResponse | ClarifyReply | KnowledgeReply
