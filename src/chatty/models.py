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
Scene = Literal["homepage", "search", "detail"]
ExperimentGroup = Literal["control", "treatment_personalized"]


class StrictModel(BaseModel):
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
    scene: Scene = "homepage"
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


class RecommendationDraft(StrictModel):
    recommendations: list[RecommendationDraftItem] = Field(min_length=1, max_length=10)


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
    experiment_group: ExperimentGroup
    products: list[RecommendedProduct]
    total_latency_ms: float = Field(ge=0)


class ExperimentOutcomeRequest(StrictModel):
    user_id: str = Field(min_length=1, max_length=64)
    success: bool
