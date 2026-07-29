"""跑推荐看结果。

    uv run python demo.py                   # 交互模式，连着换条件试
    uv run python demo.py 家电               # 只跑一次
    uv run python demo.py 家电 user_budget   # 只跑一次，指定用户

不带参数就进交互模式，带了参数就跑一次然后退出。
需要先在 .env 里配好 OPENAI_API_KEY。

每次推荐都是一次独立的请求，Chatty 不做多轮对话——它是推荐系统不是客服，
用户意图在一次请求里给全。交互模式只是省去反复敲命令，不是会话。
"""

import asyncio
import sys
import time

from chatty import config
from chatty.agent import RecommendationError, Recommender
from chatty.catalog import Catalog
from chatty.models import RecommendationRequest, UserContext

USERS = ("user_active", "user_budget", "user_vip", "user_new", "user_churn")
STEPS = "画像 → 搜索 → 库存 → 知识检索 → 营销策略 → 生成文案"
RULE = "─" * 68

# ANSI 暗色，让提示不抢正文的注意力；不是终端就留空串
DIM, RESET = ("\033[2m", "\033[0m") if sys.stdout.isatty() else ("", "")


async def _ticker() -> None:
    """跑的时候在同一行刷秒数和中断键。

    \\r 只在真终端里能盖掉上一行；输出被重定向到文件或管道时会刷屏，
    所以那种情况直接不打。
    """
    if not sys.stdout.isatty():
        return
    start = time.monotonic()
    while True:
        await asyncio.sleep(0.5)
        elapsed = time.monotonic() - start
        print(f"\r  {STEPS}  {DIM}{elapsed:4.1f}s · Ctrl-C 中断{RESET}", end="", flush=True)


async def recommend_once(service: Recommender, category: str, user_id: str) -> None:
    """跑一次推荐并打印。失败就说一句人话，不往外抛。"""
    print(f"\n  {user_id} · {category}")
    ticker = asyncio.create_task(_ticker())
    try:
        response = await service.recommend(
            RecommendationRequest(
                user_id=user_id,
                num_items=3,
                context=UserContext(preferred_categories=[category]),
            )
        )
    except RecommendationError as error:
        print(f"\r  没跑通：{error.code}{' ' * 40}")
        if error.code == "recommendation_failed":
            hint = "多半是模型这轮没按约定走（比如调了个不存在的 tool），重跑一次通常就好"
            print(f"  {DIM}{hint}{RESET}")
        return
    except asyncio.CancelledError:
        print(f"\r  已中断{' ' * 50}")
        raise
    finally:
        ticker.cancel()

    # \r 回到行首把计时那行盖掉，换成正式结果
    print(f"\r  五个工具调用完成，{response.total_latency_ms / 1000:.1f}s{' ' * 40}\n")
    for item in response.products:
        stock = "库存紧张" if item.low_stock else "有货"
        print(f"  {item.product_id}  {item.name}")
        print(f"      {item.price_cents / 100:>8.2f} 元   {DIM}{stock}{RESET}")
        print(f"      {DIM}理由{RESET}  {item.reason}")
        print(f"      {DIM}文案{RESET}  {item.marketing_copy}\n")
    # 上面的 ID、价格、库存、名称全部来自 SQLite 重查，模型只写了理由和文案。
    print(f"  {DIM}以上字段均来自 SQLite 重查，并通过 Harness 六条证据校验{RESET}\n")


async def interactive(service: Recommender) -> None:
    """连着换条件试。共用一个 Recommender，数据库和模型连接只建一次。"""
    # 类目从目录动态读，免得写死之后过期
    categories = sorted({product.category for product in service.catalog.products})

    print("\n  Chatty 交互演示")
    print(
        f"  {DIM}{config.configured_model_id()} · "
        f"{len(service.catalog.products)} 件商品 · {len(categories)} 个类目{RESET}\n"
    )
    print(f"  {DIM}类目{RESET}  {'、'.join(categories)}")
    print(f"  {DIM}用户{RESET}  {'、'.join(USERS)}")
    print(f"  {DIM}换着用户问同一个类目，能看出画像对结果的影响{RESET}\n")
    print(f"  {DIM}回车 用默认值 · q 退出{RESET}")

    while True:
        print(RULE)
        try:
            category = input("  类目 > ").strip() or "耳机"
            if category in ("q", "quit", "exit"):
                break
            user_id = input("  用户 > ").strip() or "user_active"
            if user_id in ("q", "quit", "exit"):
                break
            await recommend_once(service, category, user_id)
        except (EOFError, KeyboardInterrupt, asyncio.CancelledError):
            break
    print("\n  再见。\n")


async def main() -> None:
    args = sys.argv[1:]
    service = Recommender(Catalog())
    try:
        if args:
            # 带参数就跑一次：第一个是类目，第二个是用户 ID
            await recommend_once(service, args[0], args[1] if len(args) > 1 else "user_active")
        else:
            await interactive(service)
    finally:
        # 无论怎么退出都要关掉模型连接和数据库
        await service.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n  已中断。\n")
