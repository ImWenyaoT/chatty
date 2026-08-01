"""跑推荐看结果。

    uv run python demo.py                   # 交互模式，用大白话说需求
    uv run python demo.py 家电               # 只跑一次
    uv run python demo.py 家电 user_budget   # 只跑一次，指定用户

不带参数就进交互模式，带了参数就跑一次然后退出。
需要先在 .env 里配好 OPENAI_API_KEY。

交互模式里可以直接说「想买个降噪耳机，2000 以内」，会先把它解析成结构化
条件（类目、价格区间）再跑推荐。信息不够时 Chatty 会先反问，答完再继续——
这一整段由 chatty.conversation 的会话 module 管，评估跑的是同一份代码。

`/` 开头是命令，`/help` 看全部。`/1`…`/4` 直接跑预设需求，演示时不用现场
打字；其中两条刻意会失败或触发反问——只演成功用例看不出 Harness 在做什么。
"""

import asyncio
import logging
import sys
import time

from chatty import failure_log
from chatty.agent import RecommendationError, Recommender
from chatty.catalog import Catalog
from chatty.conversation import Conversation, Resolve
from chatty.model_provider import EnvModelProvider, ModelProvider
from chatty.models import (
    ClarifyReply,
    RecommendationRequest,
    RecommendationResponse,
    UserContext,
)
from chatty.need_parser import describe, parse_need

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



async def _tick() -> None:
    """在同一行刷秒数和中断键。

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


class _Ticker:
    """可以停下来的计时行。

    Agent 反问时轮到用户打字，计时行必须停——否则它会一直往同一行刷，
    把 `你 >` 提示符盖掉。
    """

    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(_tick())

    def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            self._task = None


def _print_response(response: RecommendationResponse) -> None:
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


def _print_error(error: RecommendationError) -> None:
    print(f"\r  没跑通：{error.code}{' ' * 40}")
    if error.code == "recommendation_failed":
        hint = "多半是模型这轮没按约定走（比如调了个不存在的 tool），重跑一次通常就好"
        print(f"  {DIM}{hint}{RESET}")
    elif error.code == "invalid_recommendation":
        print(f"  {DIM}条件太紧，目录里没有同时满足类目和价格的商品{RESET}")


async def run_conversation(
    service: Recommender,
    user_id: str,
    opening: str,
    *,
    resolve: Resolve,
    max_turns: int,
) -> None:
    """跑一次会话并把过程打给人看。

    会话循环、澄清历史的拼装和轮次上限都在 Conversation 里；这里只剩「怎么把
    大白话变成条件」「反问时问谁」这两件 demo 特有的事，以及打印。
    """
    last_context = UserContext()
    ticker = _Ticker()

    async def tracking_resolve(said: list[str]) -> UserContext:
        nonlocal last_context
        ticker.stop()
        last_context = await resolve(said)
        # 让人看见这句话被理解成了什么
        print(f"\n  {user_id} · {DIM}理解为{RESET} {describe(last_context)}")
        ticker.start()
        return last_context

    conversation = Conversation(
        service,
        user_id=user_id,
        resolve=tracking_resolve,
        num_items=3,
        max_turns=max_turns,
    )

    async def ask(question: str) -> str | None:
        ticker.stop()
        print(f"\r  Chatty 想知道：{question}{' ' * 20}")
        try:
            answer = input("  你 > ").strip()
        except (EOFError, KeyboardInterrupt):
            return None
        return None if not answer or answer in ("q", "quit", "exit") else answer

    try:
        reply = await conversation.converse(opening, ask=ask)
    except RecommendationError as error:
        # 记下来，之后用 --harvest 收成回归用例
        request = RecommendationRequest(user_id=user_id, num_items=3, context=last_context)
        failure_log.record(request, error.code, error.diagnostics)
        _print_error(error)
        return
    finally:
        ticker.stop()

    if isinstance(reply, ClarifyReply):
        # 轮次用完它还在问，或者用户中途不答了
        print(f"\r  没能问清楚，这轮就到这里{' ' * 40}\n")
        return
    _print_response(reply)


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


def resolve_command(raw: str, user_id: str, model_id: str = "") -> tuple[str | None, str, bool]:
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
        print(f"\n  {user_id} · {model_id}\n")
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


async def interactive(service: Recommender, provider: ModelProvider) -> None:
    """连着换需求试。共用一个 Recommender 和一个提供方，连接只建一次。

    早先这里为 parse_need 另建了一个客户端，于是一个进程两个连接、两条关闭路径，
    而且 /who 打的 model_id 和实际推理用的模型没有代码保证一致。现在只有一个
    提供方，两件事都不会再发生。
    """
    categories = service.catalog.categories
    model_id = provider.model_id
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
                need, user_id, keep_going = resolve_command(text, user_id, model_id)
                if not keep_going:
                    break
                if need is None:
                    continue
            else:
                need = text

            async def resolve(said: list[str]) -> UserContext:
                # 用户说过的话累积起来一起解析，否则第二轮只说「2000 以内」会丢掉类目
                return await parse_need(provider, " ".join(said), categories)

            await run_conversation(
                service, user_id, need, resolve=resolve, max_turns=MAX_CLARIFY + 1
            )
    finally:
        print("\n  再见。\n")


async def main() -> None:
    # 条件太紧、模型没按约定走，这些都是 Harness 该拦下的失败，demo 已经用人话
    # 讲了。库里那条 warning 带着完整堆栈，演示时刷在屏幕上像是崩了。留到 ERROR：
    # 真的意外异常（logger.exception）仍然会连堆栈一起打出来。
    logging.getLogger("chatty").setLevel(logging.ERROR)

    args = sys.argv[1:]
    catalog = Catalog()
    # 一个进程一个提供方：Agent Loop 和 parse_need 共用它，
    # 于是 /who 打的 model_id 就是实际推理用的那个
    provider = EnvModelProvider()
    service = Recommender(catalog, provider=provider)
    try:
        if args:
            # 带参数就跑一次：第一个是类目，第二个是用户 ID
            user_id = args[1] if len(args) > 1 else "user_active"
            print(f"\n  {user_id} · {args[0]}")
            context = UserContext(preferred_categories=[args[0]])

            async def fixed(_said: list[str]) -> UserContext:
                return context

            # 一次性给全条件，就一轮：反问了也没有下一轮来接
            await run_conversation(service, user_id, args[0], resolve=fixed, max_turns=1)
        else:
            await interactive(service, provider)
    finally:
        # provider 和 catalog 都是这里建的，就由这里关；
        # service.close() 只释放它自己建的东西（这里一样都没有）
        await service.close()
        await provider.close()
        catalog.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n  已中断。\n")
