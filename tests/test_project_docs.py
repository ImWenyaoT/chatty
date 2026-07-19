import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parents[1]


def test_single_context_has_one_architecture_entrypoint() -> None:
    assert (ROOT / "CONTEXT.md").is_file()
    assert not (ROOT / "CONTEXT-MAP.md").exists()
    assert not list((ROOT / "packages").glob("*/CONTEXT.md"))
    domain_guide = (ROOT / "docs/agents/domain.md").read_text(encoding="utf-8")
    assert "根 `CONTEXT.md`" in domain_guide
    assert "multi-context" not in domain_guide.casefold()


def test_readmes_describe_only_the_current_resume_mvp() -> None:
    for filename in ("README.md", "README.en.md"):
        text = (ROOT / filename).read_text(encoding="utf-8")
        lowered = text.casefold()
        assert "agent = model + harness" in lowered
        assert all(page in lowered for page in ("playground", "dashboard", "orders"))
        assert "python -m chatty.eval" in text
        assert "uv sync --locked" in text
        assert "pnpm install --frozen-lockfile" in text
        assert all(term not in lowered for term in ("control-plane", "outbox", "worker", "jobs"))

    chinese = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "简历项目" in chinese
    assert "生产" in chinese


def test_readme_eval_command_is_executable() -> None:
    completed = subprocess.run(
        [sys.executable, "-m", "chatty.eval", "--help"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    assert "--cases" in completed.stdout


def test_ci_keeps_all_gates_and_runs_the_deterministic_eval() -> None:
    workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    for command in (
        "uv sync --locked",
        "ruff format --check",
        "ruff check",
        "ty check",
        "pytest -q",
        "python -m chatty.eval",
        "pnpm install --frozen-lockfile",
        "pnpm lint",
        "pnpm test",
        "pnpm typecheck",
        "pnpm build",
    ):
        assert command in workflow
