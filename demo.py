"""跑一次推荐，把结果打出来看。

    uv run python demo.py              # 默认给活跃用户推荐耳机
    uv run python demo.py 家电          # 换个类目
    uv run python demo.py 手机 user_vip # 换类目和用户

用户 ID 可选 user_active、user_budget、user_vip、user_new、user_churn，
类目见 data/products.jsonl。需要先在 .env 里配好 OPENAI_API_KEY。
"""

import asyncio
import sys

from chatty.agent import Recommender
from chatty.catalog import Catalog
from chatty.models import RecommendationRequest, UserContext


async def main() -> None:
    # 命令行参数：第一个是类目，第二个是用户 ID，都有默认值
    category = sys.argv[1] if len(sys.argv) > 1 else "耳机"
    user_id = sys.argv[2] if len(sys.argv) > 2 else "user_active"

    service = Recommender(Catalog())
    try:
        response = await service.recommend(
            RecommendationRequest(
                user_id=user_id,
                num_items=3,
                context=UserContext(preferred_categories=[category]),
            )
        )
    finally:
        # 无论成功失败都要关掉模型连接和数据库
        await service.close()

    print(f"\n用户 {user_id} · 类目 {category} · 耗时 {response.total_latency_ms / 1000:.1f}s\n")
    for item in response.products:
        stock = "库存紧张" if item.low_stock else "有货"
        print(f"  {item.product_id}  {item.name}  {item.price_cents / 100:.2f} 元  [{stock}]")
        print(f"    理由：{item.reason}")
        print(f"    文案：{item.marketing_copy}\n")

    # 这几行是这个项目的重点：上面的价格、库存、名称全部来自 SQLite 重查，
    # 模型只负责写理由和文案。任何一条证据不齐都会抛错而不是降级返回。
    print("以上商品的 ID、价格、库存均已通过 Harness 的六条证据校验。")


if __name__ == "__main__":
    asyncio.run(main())
