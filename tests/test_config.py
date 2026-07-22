"""入口运行时配置测试：空值等同未设置、相对按仓库根、绝对路径原样、库文件清理。"""

from __future__ import annotations

from pathlib import Path

import pytest

from chatty import config


@pytest.mark.parametrize(
    ("resolve", "env_name", "default"),
    [
        (config.database_path, config.DATABASE_PATH_ENV, config.DEFAULT_DATABASE_PATH),
        (config.e2e_database_path, config.E2E_DATABASE_ENV, config.DEFAULT_E2E_DATABASE_PATH),
    ],
)
def test_path_env_invariants(
    resolve, env_name: str, default: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(env_name, raising=False)
    assert resolve() == config.REPO_ROOT / default

    # 空字符串等同未设置：绝不能解析成仓库根目录本身（那会把目录交给 sqlite3.connect）。
    monkeypatch.setenv(env_name, "")
    assert resolve() == config.REPO_ROOT / default
    assert resolve() != config.REPO_ROOT

    monkeypatch.setenv(env_name, ".cache/custom.sqlite")
    assert resolve() == config.REPO_ROOT / ".cache/custom.sqlite"

    absolute = tmp_path / "abs.sqlite"
    monkeypatch.setenv(env_name, str(absolute))
    assert resolve() == absolute


def test_static_dir_requires_built_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(config.STATIC_DIR_ENV, str(tmp_path / "dist"))
    assert config.static_dir() is None  # 目录不存在 → 不伺服。

    (tmp_path / "dist").mkdir()
    assert config.static_dir() is None  # 目录在但没 index.html → 仍不伺服。

    (tmp_path / "dist" / "index.html").write_text("<!doctype html>", encoding="utf-8")
    assert config.static_dir() == tmp_path / "dist"


def test_static_dir_defaults_to_repo_dist(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(config.STATIC_DIR_ENV, "")
    resolved = config.static_dir()
    expected = config.REPO_ROOT / config.DEFAULT_STATIC_DIR
    assert resolved in (None, expected)  # dist 是否已构建取决于运行环境。
    assert (expected / "index.html").is_file() == (resolved is not None)


def test_knowledge_path_follows_root(tmp_path: Path) -> None:
    assert config.knowledge_path() == config.REPO_ROOT / "knowledge" / "records.jsonl"
    assert config.knowledge_path(tmp_path) == tmp_path / "knowledge" / "records.jsonl"


def test_reset_database_removes_sidecars(tmp_path: Path) -> None:
    database_path = tmp_path / "case.sqlite"
    for suffix in ("", "-wal", "-shm"):
        Path(f"{database_path}{suffix}").write_text("stale", encoding="utf-8")

    config.reset_database(database_path)

    assert not any(Path(f"{database_path}{suffix}").exists() for suffix in ("", "-wal", "-shm"))
    config.reset_database(database_path)  # 幂等：文件已不存在也不抛。
