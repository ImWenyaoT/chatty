"""跑推荐看结果。

    uv run python demo.py                   # 活跃用户 + 耳机
    uv run python demo.py 家电 user_budget   # 换类目和用户
    uv run python demo.py -i                # 交互模式，可以连着换条件试

用户 ID 可选 user_active、user_budget、user_vip、user_new、user_churn，
类目见 data/products.jsonl。需要先在 .env 里配好 OPENAI_API_KEY。

每次推荐都是一次独立的请求，Chatty 不做多轮对话——它是推荐系统不是客服，
用户意图在一次请求里给全。交互模式只是省去反复敲命令，不是会话。
"""

import asyncio
import sys

from chatty.agent import RecommendationError, Recommender
from chatty.catalog import Catalog
from chatty.models import RecommendationRequest, UserContext

USERS = ("user_active", "user_budget", "user_vip", "user_new", "user_churn")


async def recommend_once(service: Recommender, category: str, user_id: str) -> None:
    """跑一次推荐并打印。失败就说一句人话，不往外抛。"""
    try:
        response = await service.recommend(
            RecommendationRequest(
                user_id=user_id,
                num_items=3,
                context=UserContext(preferred_categories=[category]),
            )
        )
    except RecommendationError as error:
        print(f"\n这次没跑通：{error.code}")
        if error.code == "recommendation_failed":
            print("多半是模型这轮的行为不符合约定（比如去调了一个不存在的 tool）。")
            print("这是概率性的，再跑一次通常就好。")
        return

    print(f"\n用户 {user_id} · 类目 {category} · 耗时 {response.total_latency_ms / 1000:.1f}s\n")
    for item in response.products:
        stock = "库存紧张" if item.low_stock else "有货"
        print(f"  {item.product_id}  {item.name}  {item.price_cents / 100:.2f} 元  [{stock}]")
        print(f"    理由：{item.reason}")
        print(f"    文案：{item.marketing_copy}\n")
    # 上面的 ID、价格、库存、名称全部来自 SQLite 重查，模型只写了理由和文案。
    print("以上商品均已通过 Harness 的六条证据校验。\n")


async def interactive(service: Recommender) -> None:
    """连着换条件试。共用一个 Recommender，数据库和模型连接只建一次。"""
    # 把目录里真实有的类目列出来，省得猜
    categories = sorted({product.category for product in service.catalog.products})
    print("\n交互模式。直接回车用默认值，Ctrl-C 退出。")
    print(f"  可选类目：{'、'.join(categories)}")
    print(f"  可选用户：{'、'.join(USERS)}")
    print("  换着用户问同一个类目，能看出画像对结果的影响。\n")
    while True:
        try:
            category = input("类目（回车=耳机）: ").strip() or "耳机"
            user_id = input("用户（回车=user_active）: ").strip() or "user_active"
        except (EOFError, KeyboardInterrupt):
            print("\n再见。")
            return
        await recommend_once(service, category, user_id)


async def main() -> None:
    args = sys.argv[1:]
    service = Recommender(Catalog())
    try:
        if args and args[0] in ("-i", "--interactive"):
            await interactive(service)
        else:
            # 第一个参数是类目，第二个是用户 ID，都有默认值
            category = args[0] if args else "耳机"
            user_id = args[1] if len(args) > 1 else "user_active"
            await recommend_once(service, category, user_id)
    finally:
        # 无论怎么退出都要关掉模型连接和数据库
        await service.close()


if __name__ == "__main__":
    asyncio.run(main())
