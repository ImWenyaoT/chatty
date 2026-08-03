from pathlib import Path

from app.settings import load_settings


def test_local_env_files_override_system_environment(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("DEEPSEEK_MODEL", "system-model")
    (tmp_path / ".env").write_text("DEEPSEEK_MODEL=env-model\n")
    (tmp_path / ".env.local").write_text("DEEPSEEK_MODEL=local-model\n")

    settings = load_settings(tmp_path)

    assert settings.model == "local-model"
