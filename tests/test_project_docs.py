import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parents[1]


def test_single_context_has_one_architecture_entrypoint() -> None:
    assert (ROOT / "CONTEXT.md").is_file()
    assert not (ROOT / "CONTEXT-MAP.md").exists()
    assert not list((ROOT / "packages").glob("*/CONTEXT.md"))
    domain_guide = (ROOT / "docs/agents/domain.md").read_text(encoding="utf-8")
    agent_guide = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    assert "根 `CONTEXT.md`" in domain_guide
    assert "multi-context" not in domain_guide.casefold()
    assert "CONTEXT.md" in agent_guide
    assert "multi-context" not in agent_guide.casefold()
    assert "CONTEXT-MAP.md" not in agent_guide
    assert "event-sourced orders" not in domain_guide

    adr_0001 = (ROOT / "docs/adr/0001-architecture-reference-claude-code.md").read_text(
        encoding="utf-8"
    )
    assert "ADR 0007" in adr_0001


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


def test_readme_eval_command_runs_the_deterministic_agent_path(tmp_path: Path) -> None:
    output_path = tmp_path / "results.jsonl"
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "chatty.eval",
            "--output",
            str(output_path),
            "--workdir",
            str(tmp_path / "db"),
        ],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    assert '"passed": 6' in completed.stdout
    assert len(output_path.read_text(encoding="utf-8").splitlines()) == 6


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


def test_manual_eval_workflow_uses_only_the_current_contract() -> None:
    workflow = (ROOT / ".github/workflows/eval.yml").read_text(encoding="utf-8")
    assert "uv sync --locked" in workflow
    assert "python -m chatty.eval" in workflow
    assert "--run-deepseek tests/test_deepseek_contract.py" in workflow
    assert "MODEL_ID" in workflow
    assert "CHAT_MODEL" not in workflow
    assert "EVALUATOR_MODEL" not in workflow
    assert "--repeat" not in workflow


def test_readme_start_commands_are_wired_to_ci_and_package_scripts() -> None:
    workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    package = (ROOT / "package.json").read_text(encoding="utf-8")
    assert "uv run python main.py" in workflow
    assert '"dev": "pnpm --filter @chatty/web dev"' in package
