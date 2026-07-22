"""load_root_env 共享加载器测试：解析、setdefault 不覆盖、容忍缺失文件。"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from chatty.env import load_root_env


@pytest.fixture(autouse=True)
def isolated_environ(monkeypatch: pytest.MonkeyPatch) -> None:
    """整份测试改写进程环境：换成副本，测试结束自动还原真实 os.environ。"""
    monkeypatch.setattr(os, "environ", dict(os.environ))


def test_load_root_env_parses_key_value_lines(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# 注释行\n"
        "\n"
        "CHATTY_TEST_PLAIN=hello\n"
        'CHATTY_TEST_QUOTED="wrapped value"\n'
        "CHATTY_TEST_SINGLE='single'\n"
        "CHATTY_TEST_SPACED = padded \n"
        "not-a-key-value-line\n",
        encoding="utf-8",
    )
    load_root_env(env_file)
    assert os.environ["CHATTY_TEST_PLAIN"] == "hello"
    assert os.environ["CHATTY_TEST_QUOTED"] == "wrapped value"
    assert os.environ["CHATTY_TEST_SINGLE"] == "single"
    assert os.environ["CHATTY_TEST_SPACED"] == "padded"
    assert "not-a-key-value-line" not in os.environ


def test_load_root_env_never_overrides_existing_variables(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("CHATTY_TEST_EXISTING=from-file\n", encoding="utf-8")
    os.environ["CHATTY_TEST_EXISTING"] = "from-process"
    load_root_env(env_file)
    assert os.environ["CHATTY_TEST_EXISTING"] == "from-process"


def test_load_root_env_tolerates_missing_file(tmp_path: Path) -> None:
    before = dict(os.environ)
    load_root_env(tmp_path / "absent.env")
    assert dict(os.environ) == before
