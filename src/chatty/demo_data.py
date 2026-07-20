from __future__ import annotations

import argparse
import json
import sqlite3
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from pathlib import Path

from chatty.commerce import CommerceStore, CreateOrderInput
from chatty.store import MemoryStore, SupportRequestStore


@dataclass(frozen=True)
class DemoDataSummary:
    orders: int
    memories: int
    support_requests: int


PRODUCTS = (
    ("SUIT-002", "深灰单排扣西装"),
    ("SUIT-003", "海军蓝三件套西装"),
    ("SHIRT-001", "白色礼服衬衫"),
    ("VEST-001", "黑色修身马甲"),
    ("COAT-001", "驼色羊毛大衣"),
)

MEMORIES = (
    "常穿 L 码上装",
    "偏好深色、低调的商务风格",
    "重要场合希望提前两天送达",
    "不接受含羊毛刺痒感明显的面料",
    "默认收货城市为上海",
    "更倾向租赁而不是买断",
    "参加晚间活动时偏好三件套",
    "需要可搭配黑色牛津鞋的款式",
    "希望订单变更通过 Chatty 确认",
    "通常需要开具个人抬头发票",
)

SUPPORT_CASES = (
    ("改期需人工确认", "客户希望调整已确认订单的租赁日期。"),
    ("特殊尺码咨询", "客户需要当前标准尺码之外的加长袖版本。"),
    ("加急配送评估", "活动日期临近，需要人工确认同城加急能力。"),
    ("面料过敏确认", "客户对羊毛敏感，需要人工核实具体面料成分。"),
    ("企业发票协助", "客户需要企业抬头及税号相关开票协助。"),
)


def seed_demo_data(database_path: str | Path) -> DemoDataSummary:
    database_path = Path(database_path)
    commerce = CommerceStore(database_path)
    memories = MemoryStore(database_path)
    support = SupportRequestStore(database_path)

    _seed_catalog(database_path)
    order_ids: list[str] = []
    for index in range(24):
        product_id, _ = PRODUCTS[index % len(PRODUCTS)]
        fulfillment_mode = "rental" if index % 2 == 0 else "buyout"
        start_date = date(2026, 8, 1) + timedelta(days=index * 3)
        order = commerce.create_order(
            CreateOrderInput(
                idempotency_key=f"demo-seed:order:{index + 1:02d}",
                customer_id=f"demo-customer-{index % 6 + 1:02d}",
                session_id=f"demo-session-{index % 8 + 1:02d}",
                product_id=product_id,
                size=("M", "L", "XL")[index % 3],
                fulfillment_mode=fulfillment_mode,
                quantity=1,
                start_date=start_date if fulfillment_mode == "rental" else None,
                end_date=start_date + timedelta(days=3) if fulfillment_mode == "rental" else None,
                amount_cents=38_000 + index * 2_500,
                channel=("Chatty", "小红书", "微信")[index % 3],
                address=("上海市静安区", "上海市徐汇区", "杭州市西湖区")[index % 3],
                risk=("无", "活动日期临近", "需确认面料偏好")[index % 3],
            )
        )
        target_status = ("pending", "confirmed", "cancelled")[index % 3]
        if target_status in {"confirmed", "cancelled"} and order.status == "pending":
            order = commerce.confirm_order(order.id)
        if target_status == "cancelled" and order.status != "cancelled":
            order = commerce.cancel_order(order.id)
        order_ids.append(order.id)

    memories.bind_session(session_id="demo-memory-session", customer_id="demo-customer")
    for index, fact in enumerate(MEMORIES, start=1):
        source_id = f"demo-seed:memory:{index:02d}"
        existing = memories.search(customer_id="demo-customer", query=fact, limit=10)
        if not any(item.fact == fact and item.source_id == source_id for item in existing):
            memories.save(customer_id="demo-customer", fact=fact, source_id=source_id)

    support_ids: list[str] = []
    for index, (reason, context) in enumerate(SUPPORT_CASES, start=1):
        request = support.create(
            customer_id=f"demo-customer-{index:02d}",
            session_id=f"demo-support-session-{index:02d}",
            reason=reason,
            context=context,
            model_context="由 demo seed 生成，用于检查 Harness 的 Handoff receipt 展示。",
            prior_actions=("已收集客户诉求", "尚未承诺人工处理结果"),
            idempotency_key=f"demo-seed:support:{index:02d}",
        )
        support_ids.append(request.id)

    return DemoDataSummary(
        orders=len(set(order_ids)),
        memories=len(MEMORIES),
        support_requests=len(set(support_ids)),
    )


def _seed_catalog(database_path: Path) -> None:
    with sqlite3.connect(database_path) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executemany(
            "INSERT OR IGNORE INTO products (id, name) VALUES (?, ?)",
            PRODUCTS,
        )
        connection.executemany(
            """
            INSERT OR IGNORE INTO product_variants (product_id, size, stock)
            VALUES (?, ?, 8)
            """,
            [(product_id, size) for product_id, _ in PRODUCTS for size in ("M", "L", "XL")],
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="生成可重复的 Chatty 本地模拟数据")
    parser.add_argument("--database", type=Path, default=Path("data/chatty.sqlite"))
    args = parser.parse_args()
    summary = seed_demo_data(args.database)
    print(json.dumps(asdict(summary), ensure_ascii=False))


if __name__ == "__main__":
    main()
