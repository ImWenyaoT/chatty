from __future__ import annotations

from pathlib import Path

from chatty import config
from chatty.database import Database
from chatty.models import (
    AgentDraft,
    KnowledgeHit,
    MarketingStrategy,
    Product,
    RecommendationRequest,
    RecommendedProduct,
    UserContext,
    UserProfile,
)
from chatty.repositories import CommerceRepository, KnowledgeRetriever


class CatalogError(RuntimeError):
    pass


class Catalog:
    """集中商品搜索与最终业务规则，避免 Agent 和 Tool 直接处理 SQL。

    数据库、仓储和检索器都是实现零件，不在接口里：调用方要的是「搜商品」「查库存」
    「检索知识」，不是「拿到连接自己写 SQL」。想直接测某个零件就直接构造那个零件，
    别从这里穿过去——测试和调用方走同一个 seam，这条对两边都成立。
    """

    def __init__(
        self,
        data_dir: str | Path | None = None,
        *,
        database_path: str | Path | None = None,
    ) -> None:
        self._data_dir = Path(data_dir or config.DATA_DIR)
        self._database = Database(database_path, data_dir=self._data_dir)
        self._repository = CommerceRepository(self._database)
        self._retriever = KnowledgeRetriever(self._database, self._data_dir)

        # 画像与排序维度使用启动投影；finalize 会重读价格和库存等响应真值。
        self.products = self._repository.list_products()
        self.profiles = self._repository.profiles()
        self.forbidden_words = self._repository.forbidden_words()
        self._templates = self._repository.marketing_strategies(self.forbidden_words)
        # 分群齐全性由 seed_database 校验：它在 Database.__init__ 里先跑，
        # 不齐就抛 SeedDataError，轮不到这里再查一遍。
        self.categories = sorted({product.category for product in self.products})

    def close(self) -> None:
        self._database.close()

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
        # 传了类目但全是空白 → 会退化成不过滤，模型以为筛了实际没筛，宁可报错
        if categories and not category_filter:
            raise CatalogError("invalid_product_search_categories")
        tag_filter = {value.casefold() for value in tags if value.strip()}
        if tags and not tag_filter:
            raise CatalogError("invalid_product_search_tags")
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
            key=lambda product: self._score(product, profile),
            reverse=True,
        )[:limit]

    def _score(self, product: Product, profile: UserProfile) -> float:
        """给商品打分：热度打底，再叠加画像匹配、近期行为和价格区间三个信号。"""
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
        return self._repository.inventory(product_ids)

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
        return self._retriever.retrieve(
            query,
            categories=categories,
            product_ids=product_ids,
            limit=limit,
        )

    def marketing_strategy(self, segment: str) -> MarketingStrategy:
        if segment not in self._templates:
            raise CatalogError("unknown_marketing_segment")
        return self._templates[segment]

    def finalize(
        self,
        draft: AgentDraft,
        request: RecommendationRequest,
        profile: UserProfile,
    ) -> list[RecommendedProduct]:
        # 重查 SQLite：模型可能记错价格，且从查库存到现在库存也可能变了
        current_products = {
            product.product_id: product for product in self._repository.list_products()
        }
        recommendations: list[RecommendedProduct] = []
        seen: set[str] = set()  # 防止模型把同一个商品推荐两次
        for item in draft.recommendations:
            if item.product_id in seen:
                continue
            product = current_products.get(item.product_id)
            # 商品在库里根本不存在 → 说明模型编了一个 ID，这是**异常**，直接失败。
            if product is None:
                raise CatalogError("unknown_recommended_product")
            seen.add(item.product_id)
            # 售罄或超预算是正常的业务变化，跳过即可（上面 raise 是模型错了）
            if (
                product.stock <= 0
                or product.price_cents < profile.min_price_cents
                or product.price_cents > profile.max_price_cents
            ):
                continue
            recommendations.append(
                RecommendedProduct(
                    # 下面这些业务字段**全部取自数据库**，不采信模型说的任何数值。
                    product_id=product.product_id,
                    name=product.name,
                    category=product.category,
                    price_cents=product.price_cents,
                    brand=product.brand,
                    stock=product.stock,
                    tags=product.tags,
                    score=self._score(product, profile),
                    low_stock=product.stock <= 100,
                    # 只有这两项来自模型，而且要先过一遍禁词替换。
                    reason=self._sanitize(item.reason),
                    marketing_copy=self._sanitize(item.marketing_copy),
                )
            )
            if len(recommendations) >= request.num_items:
                break  # 够数就停，多的丢掉
        # 全被过滤光了，宁可报错也不返回空列表冒充成功。
        if not recommendations:
            raise CatalogError("no_available_recommendations")
        return recommendations

    def _sanitize(self, text: str) -> str:
        """把营销禁词替换成 ***（比如"打折""优惠券"这类合规敏感词）。"""
        for word in self.forbidden_words:
            text = text.replace(word, "***")
        return text
