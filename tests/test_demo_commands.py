"""斜杠命令是演示时唯一的输入通道，走错分支就是当场卡住。

`resolve_command` 把一行输入变成 (要问的需求, 身份, 是否继续) 三元组，
这里直接钉住那张状态表。
"""

from __future__ import annotations

from typing import Any

import pytest

from demo import COMMANDS, PRESETS, parse_need, resolve_command


def test_quit_stops_the_loop() -> None:
    for raw in ("/q", "/quit", "/exit"):
        need, user_id, keep_going = resolve_command(raw, "user_active")
        assert (need, user_id, keep_going) == (None, "user_active", False)


@pytest.mark.parametrize("raw", ["/help", "/", "/?", "/presets", "/who", "/clear"])
def test_informational_commands_only_print(raw: str) -> None:
    assert resolve_command(raw, "user_vip") == (None, "user_vip", True)


def test_user_switches_identity_only_for_a_known_id() -> None:
    assert resolve_command("/user user_budget", "user_active") == (
        None,
        "user_budget",
        True,
    )
    # 未知身份不能改状态，否则后面每一轮都在用一个不存在的用户跑。
    assert resolve_command("/user nobody", "user_active") == (
        None,
        "user_active",
        True,
    )
    assert resolve_command("/user", "user_active") == (None, "user_active", True)


def test_preset_returns_its_need_and_its_own_identity() -> None:
    need, user_id, keep_going = resolve_command("/3", "user_active")
    expected_need, expected_user, _ = PRESETS[2]
    assert (need, user_id, keep_going) == (expected_need, expected_user, True)


@pytest.mark.parametrize("raw", ["/0", "/9", "/nope"])
def test_unknown_commands_never_ask_anything(raw: str) -> None:
    assert resolve_command(raw, "user_new") == (None, "user_new", True)


def test_every_preset_is_reachable_and_uses_a_real_user() -> None:
    users = {"user_active", "user_budget", "user_vip", "user_new", "user_churn"}
    for index, (need, user_id, why) in enumerate(PRESETS, start=1):
        assert user_id in users
        assert need.strip() and why.strip()
        assert resolve_command(f"/{index}", "user_active")[0] == need


def test_help_table_covers_the_commands_that_exist() -> None:
    """/help 说有的命令必须真的能走通 —— 这张表是演示时唯一的说明书。"""
    documented = " ".join(name for name, _ in COMMANDS)
    for name in ("/presets", "/user", "/who", "/clear", "/help", "/q"):
        assert name in documented


class _FakeProvider:
    """按脚本回话的提供方，用来喂那些不守 JSON 约定的输出。

    此前这里是个假 chat 客户端，得长出 `self.chat = self; self.completions = self`
    才能骗过鸭子类型——那正是 provider 不暴露裸客户端的理由。
    """

    model_id = "fake-model"

    def __init__(self, content: str | None) -> None:
        self._content = content

    def model(self) -> Any:  # pragma: no cover - parse_need 用不到 Agent Loop
        raise NotImplementedError

    async def complete(self, prompt: str, *, system: str | None = None) -> str:
        return self._content or ""

    async def close(self) -> None:
        pass


@pytest.mark.parametrize(
    "content",
    [
        "这不是 JSON",
        "{类目: 耳机}",  # 像 JSON 但不合法
        '```json\n{"category": "耳机", "max_yuan": 2000}\n```',
        '["耳机"]',  # 合法 JSON，但不是对象
        "",
        None,
    ],
)
async def test_parse_need_never_crashes_on_a_model_that_ignores_the_contract(
    content: str | None,
) -> None:
    """模型不保证输出合法 JSON，所以这一步不能把 demo 带崩。

    这正是这个项目的论点：约束靠代码守，不靠提示词。演示时模型抽一次风
    就整个退出，是最难看的失败。
    """
    context = await parse_need(_FakeProvider(content), "想买个耳机", ["耳机"])
    assert isinstance(context.preferred_categories, list)


async def test_parse_need_still_reads_a_well_formed_answer() -> None:
    """兜底不能把正常路径一起吞掉。"""
    provider = _FakeProvider('{"category": "耳机", "max_yuan": 2000}')
    context = await parse_need(provider, "想买个降噪耳机，2000 以内", ["耳机"])
    assert context.preferred_categories == ["耳机"]
    assert context.max_price_cents == 200000
