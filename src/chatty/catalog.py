from __future__ import annotations

from pathlib import Path

from chatty import config
from chatty.database import Database
from chatty.models import (
    ExperimentGroup,
    KnowledgeHit,
    MarketingStrategy,
    Product,
    RecommendationDraft,
    RecommendationRequest,
    RecommendedProduct,
    UserContext,
    UserProfile,
)
from chatty.repositories import CommerceRepository
from chatty.retrieval import KnowledgeRetriever

_SEGMENTS = {
    "new_user",
    "active",
    "high_value",
    "price_sensitive",
    "churn_risk",
}


class CatalogError(RuntimeError):
    pass


class Catalog:
    """集中商品搜索与最终业务规则，避免 Agent 和 Tool 直接处理 SQL。"""

    def __init__(
        self,
        data_dir: str | Path | None = None,
        *,
        database_path: str | Path | None = None,
    ) -> None:
        self.data_dir = Path(data_dir or config.DATA_DIR)
        self.database = Database(database_path, data_dir=self.data_dir)
        self.repository = CommerceRepository(self.database)
        self.retriever = KnowledgeRetriever(self.database)

        # 画像与排序维度使用启动投影；finalize 会重读价格和库存等响应真值。
        self.products = self.repository.list_products()
        self.profiles = self.repository.profiles()
        self.forbidden_words = self.repository.forbidden_words()
        self.templates = self.repository.marketing_strategies(self.forbidden_words)
        if set(self.templates) != _SEGMENTS:
            raise CatalogError("invalid_marketing_segments")

    def close(self) -> None:
        self.database.close()

    @property
    def knowledge_count(self) -> int:
        return self.retriever.count()

    def user_profile(self, user_id: str, overrides: UserContext) -> UserProfile:
        base = self.profiles.get(
            user_id,
            UserProfile(
                user_id=user_id,
                segment="new_user",
                preferred_categories=[],
                min_price_cents=0,
                max_price_cents=1_000_000,
            ),
        )
        return base.model_copy(
            update={
                "preferred_categories": (
                    overrides.preferred_categories or base.preferred_categories
                ),
                "min_price_cents": (
                    overrides.min_price_cents
                    if overrides.min_price_cents is not None
                    else base.min_price_cents
                ),
                "max_price_cents": (
                    overrides.max_price_cents
                    if overrides.max_price_cents is not None
                    else base.max_price_cents
                ),
                "recent_views": overrides.recent_views or base.recent_views,
                "recent_purchases": overrides.recent_purchases or base.recent_purchases,
            }
        )

    def search(
        self,
        *,
        profile: UserProfile,
        group: ExperimentGroup,
        categories: list[str],
        min_price_cents: int,
        max_price_cents: int,
        tags: list[str],
        limit: int,
    ) -> list[Product]:
        category_filter = {value.casefold() for value in categories if value.strip()}
        if min_price_cents < 0 or max_price_cents <= 0 or min_price_cents > max_price_cents:
            raise CatalogError("invalid_product_search_price_range")
        if not 1 <= limit <= 20:
            raise CatalogError("invalid_product_search_limit")
        tag_filter = {value.casefold() for value in tags if value.strip()}
        # Tool 参数负责召回；画像价格范围仍会在 finalize 再次校验。
        candidates = [
            product
            for product in self.products
            if min_price_cents <= product.price_cents <= max_price_cents
            and (not category_filter or product.category.casefold() in category_filter)
            and (not tag_filter or tag_filter.intersection(tag.casefold() for tag in product.tags))
        ]
        return sorted(
            candidates,
            key=lambda product: self.score(product, profile, group),
            reverse=True,
        )[:limit]

    def score(
        self,
        product: Product,
        profile: UserProfile,
        group: ExperimentGroup,
    ) -> float:
        # 对照组只用热度，实验组才加入画像与近期行为信号。
        if group == "control":
            return round(product.popularity_score, 4)
        preferred = {value.casefold() for value in profile.preferred_categories}
        signals = {value.casefold() for value in profile.recent_views + profile.recent_purchases}
        searchable = {
            product.name.casefold(),
            product.category.casefold(),
            *(tag.casefold() for tag in product.tags),
        }
        score = product.popularity_score * 0.55
        if product.category.casefold() in preferred:
            score += 0.25
        if signals.intersection(searchable):
            score += 0.15
        if profile.min_price_cents <= product.price_cents <= profile.max_price_cents:
            score += 0.05
        return round(min(score, 1.0), 4)

    def inventory(self, product_ids: list[str]) -> list[Product]:
        return self.repository.inventory(product_ids)

    def retrieve_knowledge(
        self,
        query: str,
        *,
        categories: list[str],
        product_ids: list[str],
        limit: int,
    ) -> list[KnowledgeHit]:
        if not 1 <= limit <= 8:
            raise CatalogError("invalid_knowledge_limit")
        return self.retriever.retrieve(
            query,
            categories=categories,
            product_ids=product_ids,
            limit=limit,
        )

    def marketing_strategy(self, segment: str) -> MarketingStrategy:
        if segment not in self.templates:
            raise CatalogError("unknown_marketing_segment")
        return self.templates[segment]

    def finalize(
        self,
        draft: RecommendationDraft,
        request: RecommendationRequest,
        profile: UserProfile,
        group: ExperimentGroup,
    ) -> list[RecommendedProduct]:
        # 最终响应重新读取 SQLite；模型输出和启动缓存都不能充当库存真值。
        current_products = {
            product.product_id: product for product in self.repository.list_products()
        }
        recommendations: list[RecommendedProduct] = []
        seen: set[str] = set()
        for item in draft.recommendations:
            if item.product_id in seen:
                continue
            product = current_products.get(item.product_id)
            if product is None:
                raise CatalogError("unknown_recommended_product")
            seen.add(item.product_id)
            if (
                product.stock <= 0
                or product.price_cents < profile.min_price_cents
                or product.price_cents > profile.max_price_cents
            ):
                continue
            recommendations.append(
                RecommendedProduct(
                    product_id=product.product_id,
                    name=product.name,
                    category=product.category,
                    price_cents=product.price_cents,
                    brand=product.brand,
                    stock=product.stock,
                    tags=product.tags,
                    score=self.score(product, profile, group),
                    low_stock=product.stock <= 100,
                    reason=self.sanitize(item.reason),
                    marketing_copy=self.sanitize(item.marketing_copy),
                )
            )
            if len(recommendations) >= request.num_items:
                break
        if not recommendations:
            raise CatalogError("no_available_recommendations")
        return recommendations

    def sanitize(self, text: str) -> str:
        for word in self.forbidden_words:
            text = text.replace(word, "***")
        return text
