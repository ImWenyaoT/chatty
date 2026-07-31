"""会话 module 的测试。

这里钉住的是**澄清协议**：Agent 反问时那一问一答要怎么记进 history。
这段形状此前逐字重复在 demo 与多轮评估两处、chatty 自己不知道它存在，
所以协议改了两边都会静默失配，而且没有任何测试盯着。
现在协议只有一份，测试也就有地方落了。
"""

from __future__ import annotations

import json

import pytest

from chatty.agent import Recommender
from chatty.catalog import Catalog
from chatty.conversation import Conversation
from chatty.models import ClarifyReply, RecommendationResponse, UserContext
from tests.test_agent import MessageStep, ScriptedModel, successful_script


def _clarify(question: str) -> MessageStep:
    return MessageStep(
        f"clarify-{question}",
        json.dumps({"action": "clarify", "question": question}, ensure_ascii=False),
    )


async def _answer(_question: str) -> str | None:
    return "耳机"


async def _resolve(_said: list[str]) -> UserContext:
    return UserContext(preferred_categories=["耳机"])


@pytest.mark.asyncio
async def test_clarify_question_goes_back_into_history(catalog: Catalog) -> None:
    """反问过的问题必须回到 history 里，否则下一轮模型看不见自己问过什么。"""
    model = ScriptedModel([_clarify("你想看哪一类商品？"), *successful_script()])
    service = Recommender(catalog, model=model)
    asked: list[str] = []

    async def ask(question: str) -> str | None:
        asked.append(question)
        return "耳机"

    try:
        reply = await Conversation(service, user_id="user_active", max_turns=3).converse(
            "想找个听歌用的", resolve=_resolve, ask=ask
        )
    finally:
        await service.close()

    assert isinstance(reply, RecommendationResponse)
    assert asked == ["你想看哪一类商品？"]

    # 第二轮喂给模型的输入里，要有那条 assistant 澄清消息
    second_turn = model.calls[1]["input"]
    assistant_messages = [
        item
        for item in second_turn
        if isinstance(item, dict) and item.get("role") == "assistant"
    ]
    assert assistant_messages, "第二轮没有把澄清记进 history"
    recorded = json.loads(assistant_messages[0]["content"])
    assert recorded == {"action": "clarify", "question": "你想看哪一类商品？"}


@pytest.mark.asyncio
async def test_everything_the_user_said_is_resolved_together(catalog: Catalog) -> None:
    """第二轮只说「2000 以内」时不能丢掉第一轮说的类目——所以每轮拿全部说过的话重解析。"""
    model = ScriptedModel([_clarify("预算多少？"), *successful_script()])
    service = Recommender(catalog, model=model)
    seen: list[list[str]] = []

    async def resolve(said: list[str]) -> UserContext:
        seen.append(list(said))
        return UserContext(preferred_categories=["耳机"])

    async def ask(_question: str) -> str | None:
        return "2000 以内"

    try:
        await Conversation(service, user_id="user_active", max_turns=3).converse(
            "想买个耳机", resolve=resolve, ask=ask
        )
    finally:
        await service.close()

    assert seen == [["想买个耳机"], ["想买个耳机", "2000 以内"]]


@pytest.mark.asyncio
async def test_user_walking_away_ends_the_conversation(catalog: Catalog) -> None:
    """ask 返回 None 表示用户不答了：把最后那个问题交回调用方，不要再问下去。"""
    model = ScriptedModel([_clarify("你想看哪一类商品？")])
    service = Recommender(catalog, model=model)

    async def ask(_question: str) -> str | None:
        return None

    try:
        reply = await Conversation(service, user_id="user_active", max_turns=3).converse(
            "随便看看", resolve=_resolve, ask=ask
        )
    finally:
        await service.close()

    assert isinstance(reply, ClarifyReply)
    assert reply.question == "你想看哪一类商品？"
    # 只跑了一轮，脚本里剩下的没被消费
    assert len(model.calls) == 1


@pytest.mark.asyncio
async def test_turns_run_out_instead_of_asking_forever(catalog: Catalog) -> None:
    """模型一直反问时要有停止条件，返回最后那个问题而不是无限循环。"""
    model = ScriptedModel([_clarify("问题一"), _clarify("问题二")])
    service = Recommender(catalog, model=model)

    try:
        reply = await Conversation(service, user_id="user_active", max_turns=2).converse(
            "想买点东西", resolve=_resolve, ask=_answer
        )
    finally:
        await service.close()

    assert isinstance(reply, ClarifyReply)
    assert reply.question == "问题二"
    assert len(model.calls) == 2


@pytest.mark.asyncio
async def test_single_turn_conversation_never_asks(catalog: Catalog) -> None:
    """max_turns=1 时没有下一轮来接问题，ask 一次都不该被调用。"""
    model = ScriptedModel([_clarify("你想看哪一类商品？")])
    service = Recommender(catalog, model=model)
    asked: list[str] = []

    async def ask(question: str) -> str | None:
        asked.append(question)
        return "耳机"

    try:
        reply = await Conversation(service, user_id="user_active", max_turns=1).converse(
            "随便看看", resolve=_resolve, ask=ask
        )
    finally:
        await service.close()

    assert isinstance(reply, ClarifyReply)
    assert asked == []


def test_max_turns_must_allow_at_least_one_turn(catalog: Catalog) -> None:
    with pytest.raises(ValueError, match="max_turns"):
        Conversation(Recommender(catalog), user_id="user_active", max_turns=0)
