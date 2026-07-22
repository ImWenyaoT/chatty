from __future__ import annotations

from pathlib import Path

from chatty import config


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
