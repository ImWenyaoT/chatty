"""商品、画像、库存、知识与营销数据的统一访问入口。"""

import json
import re
import sqlite3
from pathlib import Path

from app.database import DATA_DIR, Database, SeedDataError, segment_for_index
from app.models import (
    KnowledgeHit,
    MarketingStrategy,
    Product,
    RecommendationDraftItem,
    RecommendationRequest,
    RecommendedProduct,
    UserContext,
    UserProfile,
)

MAX_PRICE_CENTS = 1_000_000


class CatalogError(ValueError):
    """Catalog 输入或业务结果无效。"""


def _product_from_row(row: sqlite3.Row) -> Product:
    return Product(
        product_id=row["product_id"],
        name=row["name"],
        category=row["category"],
        price_cents=row["price_cents"],
        description=row["description"],
        brand=row["brand"],
        seller_id=row["seller_id"],
        stock=row["stock"],
        tags=json.loads(row["tags_json"]),
        popularity_score=row["popularity_score"],
        image_url=row["image_url"],
        source=row["source"],
    )


def _profile_from_row(row: sqlite3.Row) -> UserProfile:
    return UserProfile(
        user_id=row["user_id"],
        segment=row["segment"],
        preferred_categories=json.loads(row["preferred_categories_json"]),
        min_price_cents=row["min_price_cents"],
        max_price_cents=row["max_price_cents"],
        recent_views=json.loads(row["recent_views_json"]),
        recent_purchases=json.loads(row["recent_purchases_json"]),
    )


def _normalize(values: list[str]) -> set[str]:
    return {value.strip().lower() for value in values if value.strip()}


class Catalog:
    def __init__(
        self,
        database_path: str | Path = ":memory:",
        data_dir: str | Path = DATA_DIR,
    ) -> None:
        resolved_data_dir = Path(data_dir)
        self._database = Database(database_path, resolved_data_dir)
        self.products = self._list_products()
        self.profiles = self._load_profiles()
        self.forbidden_words = self._load_forbidden_words()
        self._templates = self._load_marketing_templates()
        self.categories = sorted({product.category for product in self.products})
        self._synonyms = self._load_synonyms(resolved_data_dir / "query_synonyms.json")

    def close(self) -> None:
        self._database.close()

    def user_profile(
        self, user_id: str, overrides: UserContext | None = None
    ) -> UserProfile:
        overrides = overrides or UserContext()
        base = self.profiles.get(user_id)
        if base is None:
            raise CatalogError("unknown_user")

        preferred_categories = base.preferred_categories
        if overrides.preferred_categories:
            preferred_categories = overrides.preferred_categories

        # 单边价格约束代表本轮新区间，另一端应开放，不能继承冲突的历史区间。
        min_price_cents = overrides.min_price_cents
        if min_price_cents is None:
            if overrides.max_price_cents is None:
                min_price_cents = base.min_price_cents
            else:
                min_price_cents = 0

        max_price_cents = overrides.max_price_cents
        if max_price_cents is None:
            if overrides.min_price_cents is None:
                max_price_cents = base.max_price_cents
            else:
                max_price_cents = MAX_PRICE_CENTS

        return UserProfile(
            user_id=base.user_id,
            segment=base.segment,
            preferred_categories=preferred_categories,
            min_price_cents=min_price_cents,
            max_price_cents=max_price_cents,
            recent_views=overrides.recent_views or base.recent_views,
            recent_purchases=overrides.recent_purchases or base.recent_purchases,
        )

    def search(
        self,
        *,
        profile: UserProfile,
        categories: list[str],
        min_price_cents: int,
        max_price_cents: int,
        limit: int,
    ) -> list[Product]:
        if (
            min_price_cents < 0
            or max_price_cents <= 0
            or min_price_cents > max_price_cents
        ):
            raise CatalogError("invalid_product_search_price_range")
        if limit < 1 or limit > 20:
            raise CatalogError("invalid_product_search_limit")

        normalized_categories = _normalize(categories)
        if categories and not normalized_categories:
            raise CatalogError("invalid_product_search_categories")

        matches: list[Product] = []
        for product in self.products:
            if not min_price_cents <= product.price_cents <= max_price_cents:
                continue
            if (
                normalized_categories
                and product.category.lower() not in normalized_categories
            ):
                continue
            matches.append(product)

        matches.sort(key=lambda product: self._score(product, profile), reverse=True)
        return matches[:limit]

    def inventory(self, product_ids: list[str]) -> list[Product]:
        current = {product.product_id: product for product in self._list_products()}
        unknown_product_ids = sorted(set(product_ids) - set(current))
        if unknown_product_ids:
            raise CatalogError(
                f"unknown_inventory_product:{','.join(unknown_product_ids)}"
            )
        available: list[Product] = []
        seen: set[str] = set()
        for product_id in product_ids:
            if product_id in seen:
                continue
            seen.add(product_id)
            product = current.get(product_id)
            if product is not None and product.stock > 0:
                available.append(product)
        return available

    def retrieve_knowledge(
        self,
        *,
        query: str,
        categories: list[str],
        product_ids: list[str],
        limit: int,
    ) -> list[KnowledgeHit]:
        if limit < 1 or limit > 8:
            raise CatalogError("invalid_knowledge_limit")

        # Harness 已知的类目放在 query 前，避免长商品名挤掉稳定检索词。
        combined_query = " ".join([*categories, query])
        expression = self._match_expression(self._rewrite_query(combined_query))
        if not expression:
            raise CatalogError("empty_knowledge_query")

        filters: list[str] = []
        parameters: list[str | int] = [expression]
        if categories:
            placeholders = ",".join("?" for _ in categories)
            filters.append(f"f.category IN ({placeholders})")
            parameters.extend(categories)
        if product_ids:
            placeholders = ",".join("?" for _ in product_ids)
            filters.append(
                f"(f.product_id IN ({placeholders}) OR f.product_id IS NULL)"
            )
            parameters.extend(product_ids)

        filter_sql = ""
        if filters:
            filter_sql = " AND " + " AND ".join(filters)
        parameters.append(limit)

        rows = self._database.connection.execute(
            f"""
            SELECT d.doc_id, d.title, f.chunk_ordinal,
                   f.raw_content AS content, d.category, d.product_id,
                   d.source, bm25(knowledge_documents_fts) AS rank
            FROM knowledge_documents_fts AS f
            JOIN knowledge_documents AS d ON d.doc_id = f.doc_id
            WHERE knowledge_documents_fts MATCH ?{filter_sql}
            ORDER BY rank, f.rowid
            LIMIT ?
            """,
            parameters,
        ).fetchall()

        hits: list[KnowledgeHit] = []
        for row in rows:
            rank = float(row["rank"])
            hits.append(
                KnowledgeHit(
                    doc_id=row["doc_id"],
                    title=row["title"],
                    content=row["content"],
                    category=row["category"],
                    product_id=row["product_id"],
                    source=row["source"],
                    chunk_ordinal=row["chunk_ordinal"],
                    relevance_score=round(1 / (1 + abs(rank)), 4),
                )
            )
        return hits

    def marketing_strategy(self, segment: str) -> MarketingStrategy:
        strategy = self._templates.get(segment)
        if strategy is None:
            raise CatalogError("unknown_marketing_segment")
        return strategy

    def finalize(
        self,
        draft: list[RecommendationDraftItem],
        request: RecommendationRequest,
        profile: UserProfile,
    ) -> list[RecommendedProduct]:
        current = {product.product_id: product for product in self._list_products()}
        recommendations: list[RecommendedProduct] = []
        seen: set[str] = set()

        for item in draft:
            if item.product_id in seen:
                raise CatalogError("duplicate_recommended_product")
            product = current.get(item.product_id)
            if product is None:
                raise CatalogError("unknown_recommended_product")
            seen.add(item.product_id)

            if product.stock <= 0:
                raise CatalogError("recommended_product_out_of_stock")
            is_inside_price_range = (
                profile.min_price_cents
                <= product.price_cents
                <= profile.max_price_cents
            )
            if not is_inside_price_range:
                raise CatalogError("recommended_product_outside_price_range")

            recommendations.append(
                RecommendedProduct(
                    product_id=product.product_id,
                    name=product.name,
                    category=product.category,
                    price_cents=product.price_cents,
                    brand=product.brand,
                    stock=product.stock,
                    tags=product.tags,
                    low_stock=product.stock <= 100,
                    reason=self._sanitize(item.reason),
                    marketing_copy=self._sanitize(item.marketing_copy),
                )
            )
            if len(recommendations) >= request.num_items:
                break

        if not recommendations:
            raise CatalogError("no_available_recommendations")
        return recommendations

    def update_user_profile_after_success(
        self, user_id: str, categories: list[str]
    ) -> None:
        """只把一次成功请求里明确表达的类目写入画像。"""

        profile = self.profiles.get(user_id)
        preferred: list[str] = []
        seen_categories: set[str] = set()
        for category in categories:
            if not category.strip() or category in seen_categories:
                continue
            preferred.append(category)
            seen_categories.add(category)
        if profile is None or not preferred:
            return

        self._database.connection.execute(
            """UPDATE user_profiles
               SET preferred_categories_json = ?
               WHERE user_id = ?""",
            (json.dumps(preferred, ensure_ascii=False), user_id),
        )
        self._database.connection.commit()
        self.profiles[user_id] = profile.model_copy(
            update={"preferred_categories": preferred}
        )

    def _list_products(self) -> list[Product]:
        rows = self._database.connection.execute(
            "SELECT * FROM products ORDER BY product_id"
        ).fetchall()
        return [_product_from_row(row) for row in rows]

    def _load_profiles(self) -> dict[str, UserProfile]:
        rows = self._database.connection.execute(
            "SELECT * FROM user_profiles ORDER BY user_id"
        ).fetchall()
        profiles = [_profile_from_row(row) for row in rows]
        return {profile.user_id: profile for profile in profiles}

    def _load_forbidden_words(self) -> list[str]:
        rows = self._database.connection.execute(
            "SELECT word FROM forbidden_words ORDER BY rowid"
        ).fetchall()
        return [row["word"] for row in rows]

    def _load_marketing_templates(self) -> dict[str, MarketingStrategy]:
        rows = self._database.connection.execute(
            "SELECT * FROM marketing_templates"
        ).fetchall()
        return {
            row["segment"]: MarketingStrategy(
                segment=row["segment"],
                tone=row["tone"],
                instructions=row["instructions"],
                forbidden_words=self.forbidden_words,
            )
            for row in rows
        }

    def _score(self, product: Product, profile: UserProfile) -> float:
        preferred = _normalize(profile.preferred_categories)
        signals = _normalize([*profile.recent_views, *profile.recent_purchases])
        searchable = _normalize([product.name, product.category, *product.tags])

        score = product.popularity_score * 0.55
        if product.category.lower() in preferred:
            score += 0.25
        if any(signal in searchable for signal in signals):
            score += 0.15
        if profile.min_price_cents <= product.price_cents <= profile.max_price_cents:
            score += 0.05
        return round(min(score, 1), 4)

    def _sanitize(self, text: str) -> str:
        sanitized = text
        for word in self.forbidden_words:
            sanitized = sanitized.replace(word, "***")
        return sanitized

    @staticmethod
    def _load_synonyms(path: Path) -> dict[str, list[str]]:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise SeedDataError("invalid_query_synonyms")
        reversed_synonyms: dict[str, list[str]] = {}
        for canonical, variants in raw.items():
            if canonical.startswith("_"):
                continue
            if not isinstance(variants, list):
                raise SeedDataError("invalid_query_synonym_variants")
            for variant in variants:
                if not isinstance(variant, str):
                    raise SeedDataError("invalid_query_synonym_variant")
                reversed_synonyms.setdefault(variant, []).append(canonical)
        return reversed_synonyms

    def _rewrite_query(self, query: str) -> str:
        extra_terms: list[str] = []
        for variant, canonical_terms in self._synonyms.items():
            if variant not in query:
                continue
            for term in canonical_terms:
                if term not in query and term not in extra_terms:
                    extra_terms.append(term)
        if not extra_terms:
            return query
        return f"{query} {' '.join(extra_terms)}"

    @staticmethod
    def _match_expression(query: str) -> str:
        tokens = re.findall(r"[\w]+", query.lower(), flags=re.UNICODE)[:8]
        escaped_tokens: list[str] = []
        for token in tokens:
            indexed = segment_for_index(token).strip().replace('"', '""')
            escaped_tokens.append(f'"{indexed}"')
        return " OR ".join(escaped_tokens)
