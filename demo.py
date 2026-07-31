"""跑推荐看结果。

    uv run python demo.py                   # 交互模式，用大白话说需求
    uv run python demo.py 家电               # 只跑一次
    uv run python demo.py 家电 user_budget   # 只跑一次，指定用户

不带参数就进交互模式，带了参数就跑一次然后退出。
需要先在 .env 里配好 OPENAI_API_KEY。

交互模式里可以直接说「想买个降噪耳机，2000 以内」，会先把它解析成结构化
条件（类目、价格区间）再跑推荐。但每次仍是一次独立请求——Chatty 不做多轮
对话，它是推荐系统不是客服，上一句说过的东西不会带到下一句。

`/` 开头是命令，`/help` 看全部。`/1`…`/4` 直接跑预设需求，演示时不用现场
打字；其中两条刻意会失败或触发反问——只演成功用例看不出 Harness 在做什么。
"""

import asyncio
import json
import logging
import sys
import time

from agents.items import TResponseInputItem

from chatty import config
from chatty.agent import RecommendationError, Recommender, build_model
from chatty.catalog import Catalog
from chatty.models import ClarifyReply, RecommendationRequest, UserContext
from evals.harvest import record_failure

USERS = ("user_active", "user_budget", "user_vip", "user_new", "user_churn")
STEPS = "画像 → 搜索 → 库存 → 知识检索 → 营销策略 → 生成文案"
RULE = "─" * 68

# 斜杠命令。顺序就是 /help 里的顺序，常用的排前面。
COMMANDS: tuple[tuple[str, str], ...] = (
    ("/1 … /4", "跑第 n 条预设需求，省得现场打字"),
    ("/presets", "列出预设需求"),
    ("/user <id>", "换个身份问；不带参数就列出所有身份"),
    ("/who", "当前身份与模型"),
    ("/clear", "清屏"),
    ("/help", "这张表"),
    ("/q", "退出"),
)

# 预设需求：需求、以谁的身份问、这条想让人看见什么。
# 后两条是刻意留的：一条应当明确失败，一条应当触发反问 —— 光看成功用例
# 看不出 Harness 在做什么。
PRESETS: tuple[tuple[str, str, str], ...] = (
    ("想买个降噪耳机，2000 以内", "user_active", "常规推荐，五个工具全跑通"),
    ("三千以上的手机", "user_vip", "多约束：类目 + 价格下限"),
    ("五万以上的耳机", "user_budget", "条件太紧：应当明确失败，而不是硬凑一个"),
    ("想买个能用很久的电脑", "user_new", "需求太模糊：可能先反问再推荐"),
)
MAX_CLARIFY = 2  # 最多让它追问两次，免得绕不出来

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
    # 模型可能把 JSON 包在代码块里，抠出大括号那段。
    # 抠出来的也可能不是合法 JSON —— 这一步本来就是「模型说了不算」的地方，
    # 解析不了就当没给条件，按原话去搜，绝不让 demo 在这里崩掉。
    start, end = raw.find("{"), raw.rfind("}")
    try:
        parsed = json.loads(raw[start : end + 1]) if start != -1 and end > start else {}
    except json.JSONDecodeError:
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}

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


async def run_turn(
    service: Recommender,
    context: UserContext,
    user_id: str,
    history: list[TResponseInputItem],
) -> str | None:
    """跑一轮。给出推荐就打印并返回 None；反问就打印问题并把它返回给上层。"""
    request = RecommendationRequest(user_id=user_id, num_items=3, context=context)
    ticker = asyncio.create_task(_ticker())
    try:
        reply = await service.respond(request, history=history)
        if isinstance(reply, ClarifyReply):
            print(f"\r  Chatty 想知道：{reply.question}{' ' * 20}")
            # 把这一问一答记进历史，下一轮模型才知道自己问过什么
            history.append({"role": "user", "content": request.model_dump_json()})
            history.append(
                {
                    "role": "assistant",
                    "content": json.dumps(
                        {"action": "clarify", "question": reply.question}, ensure_ascii=False
                    ),
                }
            )
            return reply.question
        response = reply
    except RecommendationError as error:
        # 记下来，之后用 --harvest 收成回归用例
        record_failure(request.model_dump(mode="json"), error.code, error.diagnostics)
        print(f"\r  没跑通：{error.code}{' ' * 40}")
        if error.code == "recommendation_failed":
            hint = "多半是模型这轮没按约定走（比如调了个不存在的 tool），重跑一次通常就好"
            print(f"  {DIM}{hint}{RESET}")
        elif error.code == "invalid_recommendation":
            print(f"  {DIM}条件太紧，目录里没有同时满足类目和价格的商品{RESET}")
        return None
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
    return None


def print_commands() -> None:
    width = max(len(name) for name, _ in COMMANDS)
    print()
    for name, description in COMMANDS:
        print(f"  {name:<{width}}  {DIM}{description}{RESET}")
    print()


def print_presets() -> None:
    print()
    for index, (need, user_id, why) in enumerate(PRESETS, start=1):
        print(f"  {DIM}/{index}{RESET}  {need}")
        print(f"      {DIM}{user_id} · {why}{RESET}")
    print()


def resolve_command(raw: str, user_id: str) -> tuple[str | None, str, bool]:
    """处理一条斜杠命令。

    返回 (要问的需求, 身份, 是否继续)。需求为 None 表示这条命令只改状态或只打印，
    不发起推荐。
    """
    name, _, argument = raw[1:].partition(" ")
    argument = argument.strip()

    if name in ("q", "quit", "exit"):
        return None, user_id, False
    if name in ("", "help", "?"):
        print_commands()
    elif name == "presets":
        print_presets()
    elif name == "who":
        print(f"\n  {user_id} · {config.configured_model_id()}\n")
    elif name == "clear":
        print("\033[2J\033[H", end="")
    elif name == "user":
        if not argument:
            print(f"\n  {DIM}{'、'.join(USERS)}{RESET}\n")
        elif argument in USERS:
            print(f"\n  已切到 {argument}\n")
            return None, argument, True
        else:
            print(f"\n  没有这个身份：{argument}\n")
    elif name.isdigit() and 1 <= int(name) <= len(PRESETS):
        need, preset_user, _ = PRESETS[int(name) - 1]
        print(f"  {need}")  # 回显，让人看见这一轮问的是什么
        return need, preset_user, True
    else:
        print(f"\n  没有 /{name} 这条命令，/help 看全部\n")
    return None, user_id, True


async def interactive(service: Recommender) -> None:
    """连着换需求试。共用一个 Recommender，数据库和模型连接只建一次。"""
    categories = sorted({product.category for product in service.catalog.products})
    _, client = build_model()
    model_id = config.configured_model_id()
    user_id = "user_active"

    print("\n  Chatty 交互演示")
    print(
        f"  {DIM}{model_id} · {len(service.catalog.products)} 件商品 · "
        f"{len(categories)} 个类目{RESET}\n"
    )
    print(f"  {DIM}用大白话说需求即可，比如「想买个降噪耳机，2000 以内」{RESET}")
    print(f"  {DIM}类目{RESET}  {'、'.join(categories)}")
    print(f"  {DIM}换个身份问同样的需求，能看出画像对结果的影响{RESET}")
    print(f"  {DIM}/ 开头是命令，/help 看全部，/1 直接跑第一条预设{RESET}")

    try:
        while True:
            print(RULE)
            try:
                text = input(f"  {user_id} > ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if not text:
                continue

            if text.startswith("/"):
                need, user_id, keep_going = resolve_command(text, user_id)
                if not keep_going:
                    break
                if need is None:
                    continue
            else:
                need = text

            # 用户说过的话累积起来一起解析，否则第二轮只说「2000 以内」会丢掉类目
            said = [need]
            history: list[TResponseInputItem] = []
            for _ in range(MAX_CLARIFY + 1):
                context = await parse_need(client, model_id, " ".join(said), categories)
                print(f"\n  {user_id} · {DIM}理解为{RESET} {describe(context)}")
                question = await run_turn(service, context, user_id, history)
                if question is None:
                    break  # 已经给出推荐
                try:
                    answer = input("  你 > ").strip()
                except (EOFError, KeyboardInterrupt):
                    break
                if not answer or answer in ("q", "quit", "exit"):
                    break
                said.append(answer)
    finally:
        await client.close()
    print("\n  再见。\n")


async def main() -> None:
    # 条件太紧、模型没按约定走，这些都是 Harness 该拦下的失败，demo 已经用人话
    # 讲了。库里那条 warning 带着完整堆栈，演示时刷在屏幕上像是崩了。留到 ERROR：
    # 真的意外异常（logger.exception）仍然会连堆栈一起打出来。
    logging.getLogger("chatty").setLevel(logging.ERROR)

    args = sys.argv[1:]
    catalog = Catalog()
    service = Recommender(catalog)
    try:
        if args:
            # 带参数就跑一次：第一个是类目，第二个是用户 ID
            user_id = args[1] if len(args) > 1 else "user_active"
            print(f"\n  {user_id} · {args[0]}")
            await run_turn(service, UserContext(preferred_categories=[args[0]]), user_id, [])
        else:
            await interactive(service)
    finally:
        # service.close() 只关它自己建的模型连接；Catalog 是这里建的，这里关
        await service.close()
        catalog.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n  已中断。\n")
