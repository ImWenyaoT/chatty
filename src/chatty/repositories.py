from __future__ import annotations

import json
from typing import cast

from chatty.database import Database
from chatty.models import MarketingStrategy, Product, UserProfile, UserSegment


class CommerceRepository:
    """把 SQLite 行转换成业务模型，不承载推荐决策。"""

    def __init__(self, database: Database) -> None:
        self.database = database

    def list_products(self) -> list[Product]:
        with self.database.lock:
            rows = self.database.connection.execute(
                "SELECT * FROM products ORDER BY product_id"
            ).fetchall()
        return [
            Product(
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
            for row in rows
        ]

    def profiles(self) -> dict[str, UserProfile]:
        with self.database.lock:
            rows = self.database.connection.execute(
                "SELECT * FROM user_profiles ORDER BY user_id"
            ).fetchall()
        return {
            row["user_id"]: UserProfile(
                user_id=row["user_id"],
                segment=cast(UserSegment, row["segment"]),
                preferred_categories=json.loads(row["preferred_categories_json"]),
                min_price_cents=row["min_price_cents"],
                max_price_cents=row["max_price_cents"],
                recent_views=json.loads(row["recent_views_json"]),
                recent_purchases=json.loads(row["recent_purchases_json"]),
            )
            for row in rows
        }

    def marketing_strategies(self, forbidden_words: list[str]) -> dict[str, MarketingStrategy]:
        with self.database.lock:
            rows = self.database.connection.execute(
                "SELECT * FROM marketing_templates ORDER BY segment"
            ).fetchall()
        return {
            row["segment"]: MarketingStrategy(
                segment=cast(UserSegment, row["segment"]),
                tone=row["tone"],
                instructions=row["instructions"],
                forbidden_words=forbidden_words,
            )
            for row in rows
        }

    def forbidden_words(self) -> list[str]:
        with self.database.lock:
            rows = self.database.connection.execute(
                "SELECT word FROM forbidden_words ORDER BY rowid"
            ).fetchall()
        return [row["word"] for row in rows]

    def inventory(self, product_ids: list[str]) -> list[Product]:
        if not product_ids:
            return []
        products = {product.product_id: product for product in self.list_products()}
        return [
            product
            for product_id in dict.fromkeys(product_ids)
            if (product := products.get(product_id)) is not None and product.stock > 0
        ]
