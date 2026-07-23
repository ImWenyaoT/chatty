from __future__ import annotations

import logging
from pathlib import Path

from chatty import config
from chatty.debug import AgentDebugHooks


def test_default_model_is_current_deepseek_v4_pro() -> None:
    assert config.DEFAULT_MODEL_ID == "deepseek-v4-pro"


def test_env_supports_dotenv_syntax(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / ".env").write_text(
        'MODEL_PREFIX="deepseek"\nMODEL_ID=${MODEL_PREFIX}-v4-pro\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "ROOT", tmp_path)
    monkeypatch.delenv("MODEL_PREFIX", raising=False)
    monkeypatch.delenv("MODEL_ID", raising=False)

    assert config.configured_model_id() == "deepseek-v4-pro"


def test_process_environment_takes_precedence(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / ".env").write_text("MODEL_ID=from-file\n", encoding="utf-8")
    monkeypatch.setattr(config, "ROOT", tmp_path)
    monkeypatch.setenv("MODEL_ID", "from-process")

    assert config.configured_model_id() == "from-process"


def test_agent_debug_is_explicitly_enabled(monkeypatch) -> None:
    monkeypatch.delenv("CHATTY_AGENT_DEBUG", raising=False)
    assert config.agent_debug_enabled() is False

    for value in ("1", "true", "YES", "on"):
        monkeypatch.setenv("CHATTY_AGENT_DEBUG", value)
        assert config.agent_debug_enabled() is True

    monkeypatch.setenv("CHATTY_AGENT_DEBUG", "invalid")
    assert config.agent_debug_enabled() is False


def test_debug_hooks_enable_agent_trace_logger() -> None:
    logger = logging.getLogger("chatty.agent")
    previous_level = logger.level
    try:
        logger.setLevel(logging.NOTSET)
        AgentDebugHooks("scripted-model")
        assert logger.isEnabledFor(logging.INFO)
    finally:
        logger.setLevel(previous_level)
