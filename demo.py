"""跑推荐看结果。

    uv run python demo.py                   # 交互模式，用大白话说需求
    uv run python demo.py 家电               # 只跑一次
    uv run python demo.py 家电 user_budget   # 只跑一次，指定用户

不带参数就进交互模式，带了参数就跑一次然后退出。
需要先在 .env 里配好 OPENAI_API_KEY。

交互模式里可以直接说「想买个降噪耳机，2000 以内」，会先把它解析成结构化
条件（类目、价格区间）再跑推荐。但每次仍是一次独立请求——Chatty 不做多轮
对话，它是推荐系统不是客服，上一句说过的东西不会带到下一句。
"""

import asyncio
import json
import sys
import time

from chatty import config
from chatty.agent import RecommendationError, Recommender, build_model
from chatty.catalog import Catalog
from chatty.models import RecommendationRequest, UserContext

USERS = ("user_active", "user_budget", "user_vip", "user_new", "user_churn")
STEPS = "画像 → 搜索 → 库存 → 知识检索 → 营销策略 → 生成文案"
RULE = "─" * 68

# ANSI 暗色，让提示不抢正文的注意力；不是终端就留空串
DIM, RESET = ("\033[2m", "\033[0m") if sys.stdout.isatty() else ("", "")

PARSE_PROMPT = """把用户的购物需求转成 JSON，只输出 JSON 不要别的：
{{"category": "类目名或 null", "min_yuan": 数字或 null, "max_yuan": 数字或 null}}

可选类目只有：{categories}
挑最接近的一个；实在对不上就填 null。价格用元为单位。

例：
「想买个降噪耳机，2000 以内」-> {{"category": "耳机", "min_yuan": null, "max_yuan": 2000}}
「三千以上的手机」          -> {{"category": "手机", "min_yuan": 3000, "max_yuan": null}}
"""


def _to_cents(yuan: object) -> int | None:
    return int(yuan * 100) if isinstance(yuan, int | float) else None


async def parse_need(client, model_id: str, text: str, categories: list[str]) -> UserContext:
    """把一句大白话转成结构化的检索条件。

    这是 demo 的输入适配，不属于 Agent 本身——真正的五个工具跑在这之后，
    拿到的仍然是结构化请求。
    """
    completion = await client.chat.completions.create(
        model=model_id,
        messages=[
            {"role": "system", "content": PARSE_PROMPT.format(categories="、".join(categories))},
            {"role": "user", "content": text},
        ],
        extra_body={"thinking": {"type": "disabled"}},
    )
    raw = completion.choices[0].message.content or "{}"
    # 模型可能把 JSON 包在代码块里，抠出大括号那段
    start, end = raw.find("{"), raw.rfind("}")
    parsed = json.loads(raw[start : end + 1]) if start != -1 and end > start else {}

    return UserContext(
        preferred_categories=[parsed["category"]] if parsed.get("category") in categories else [],
        min_price_cents=_to_cents(parsed.get("min_yuan")),
        max_price_cents=_to_cents(parsed.get("max_yuan")),
    )


def describe(context: UserContext) -> str:
    """把解析结果说给人听，让人看见这句话被理解成了什么。"""
    bits = list(context.preferred_categories) or ["不限类目"]
    if context.min_price_cents:
        bits.append(f"≥{context.min_price_cents / 100:.0f} 元")
    if context.max_price_cents:
        bits.append(f"≤{context.max_price_cents / 100:.0f} 元")
    return " · ".join(bits)


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


async def recommend_once(service: Recommender, context: UserContext, user_id: str) -> None:
    """跑一次推荐并打印。失败就说一句人话，不往外抛。"""
    ticker = asyncio.create_task(_ticker())
    try:
        response = await service.recommend(
            RecommendationRequest(user_id=user_id, num_items=3, context=context)
        )
    except RecommendationError as error:
        print(f"\r  没跑通：{error.code}{' ' * 40}")
        if error.code == "recommendation_failed":
            hint = "多半是模型这轮没按约定走（比如调了个不存在的 tool），重跑一次通常就好"
            print(f"  {DIM}{hint}{RESET}")
        elif error.code == "invalid_recommendation":
            print(f"  {DIM}条件太紧，目录里没有同时满足类目和价格的商品{RESET}")
        return
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
    """连着换需求试。共用一个 Recommender，数据库和模型连接只建一次。"""
    categories = sorted({product.category for product in service.catalog.products})
    _, client = build_model()
    model_id = config.configured_model_id()

    print("\n  Chatty 交互演示")
    print(
        f"  {DIM}{model_id} · {len(service.catalog.products)} 件商品 · "
        f"{len(categories)} 个类目{RESET}\n"
    )
    print(f"  {DIM}用大白话说需求即可，比如「想买个降噪耳机，2000 以内」{RESET}")
    print(f"  {DIM}类目{RESET}  {'、'.join(categories)}")
    print(f"  {DIM}用户{RESET}  {'、'.join(USERS)}")
    print(f"  {DIM}换个用户问同样的需求，能看出画像对结果的影响{RESET}\n")
    print(f"  {DIM}回车 用默认值 · q 退出{RESET}")

    try:
        while True:
            print(RULE)
            try:
                text = input("  想买点什么 > ").strip() or "推荐个降噪耳机"
                if text in ("q", "quit", "exit"):
                    break
                user_id = input("  以谁的身份（回车=user_active）> ").strip() or "user_active"
                if user_id in ("q", "quit", "exit"):
                    break
            except (EOFError, KeyboardInterrupt):
                break

            context = await parse_need(client, model_id, text, categories)
            print(f"\n  {user_id} · {DIM}理解为{RESET} {describe(context)}")
            await recommend_once(service, context, user_id)
    finally:
        await client.close()
    print("\n  再见。\n")


async def main() -> None:
    args = sys.argv[1:]
    service = Recommender(Catalog())
    try:
        if args:
            # 带参数就跑一次：第一个是类目，第二个是用户 ID
            user_id = args[1] if len(args) > 1 else "user_active"
            print(f"\n  {user_id} · {args[0]}")
            await recommend_once(service, UserContext(preferred_categories=[args[0]]), user_id)
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
