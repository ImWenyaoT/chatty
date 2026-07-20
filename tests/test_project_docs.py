import json
import re
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
    assert "ADR 0008" in adr_0001


def test_repository_has_only_python_backend_and_thin_web_runtime() -> None:
    forbidden_paths = [
        ROOT / "packages",
        ROOT / "apps/web/app/api",
        ROOT / "scripts/worker.mts",
        ROOT / "scripts/worker-integration.mts",
        ROOT / "scripts/fullstack-integration.mts",
        ROOT / "scripts/smoke.mts",
        ROOT / "apps/web/lib/db.ts",
        ROOT / "apps/web/lib/background-job-worker.ts",
        ROOT / "apps/web/lib/control-plane-read-model.ts",
        ROOT / "apps/web/lib/customer-service-turn.ts",
        ROOT / "apps/web/lib/harness-run-controller.ts",
        ROOT / "apps/web/lib/llm.ts",
        ROOT / "apps/web/lib/memory-pipeline.ts",
    ]
    assert [str(path.relative_to(ROOT)) for path in forbidden_paths if path.exists()] == []

    workspace = (ROOT / "pnpm-workspace.yaml").read_text(encoding="utf-8")
    assert '"apps/*"' in workspace
    assert "packages/*" not in workspace

    root_package = (ROOT / "package.json").read_text(encoding="utf-8")
    web_package = (ROOT / "apps/web/package.json").read_text(encoding="utf-8")
    forbidden_dependencies = (
        "@rental/",
        "@openai/agents",
        "better-sqlite3",
        "openai",
        "zod",
    )
    for dependency in forbidden_dependencies:
        assert dependency not in root_package
        assert dependency not in web_package


def test_web_source_cannot_own_backend_or_platform_concerns() -> None:
    source_paths = list((ROOT / "apps/web/app").rglob("*.ts"))
    source_paths += list((ROOT / "apps/web/app").rglob("*.tsx"))
    source_paths.append(ROOT / "apps/web/next.config.ts")
    web_sources = "\n".join(path.read_text(encoding="utf-8") for path in source_paths).casefold()
    for forbidden in (
        "better-sqlite3",
        "@rental/",
        "control-plane",
        "background-job",
        "outbox",
        "checkpoint",
        "provider router",
    ):
        assert forbidden not in web_sources


def test_contracted_source_cannot_regrow_a_second_platform() -> None:
    active_sources = list((ROOT / "src/chatty").glob("*.py"))
    active_sources += list((ROOT / "apps/web/app").rglob("*.ts"))
    active_sources += list((ROOT / "apps/web/app").rglob("*.tsx"))
    source = "\n".join(path.read_text(encoding="utf-8") for path in active_sources)
    web_source = "\n".join(
        path.read_text(encoding="utf-8")
        for path in active_sources
        if path.is_relative_to(ROOT / "apps/web")
    )

    forbidden_path_parts = {"api", "jobs", "worker", "workers", "outbox", "checkpoints"}
    assert not {
        part
        for path in active_sources
        for part in path.relative_to(ROOT).parts
        if part.casefold() in forbidden_path_parts
    }
    assert not re.search(
        r"(?:better-sqlite3|node:sqlite|@rental/db|CHATTY_DB_PATH|"
        r"(?:from|import)\s+[^\n]*(?:sqlite|\bdb\b))",
        web_source,
        re.IGNORECASE,
    )
    assert not re.search(r"\b(?:rag|vector database|vector db)\b", source, re.IGNORECASE)
    assert "@openai/agents" not in source
    assert source.count("Runner.run(") == 1


def test_readmes_describe_only_the_current_resume_mvp() -> None:
    for filename in ("README.md", "README.en.md"):
        text = (ROOT / filename).read_text(encoding="utf-8")
        lowered = text.casefold()
        assert "agent = model + harness" in lowered
        assert all(page in lowered for page in ("playground", "dashboard", "orders"))
        assert "python -m chatty.eval" in text
        assert "python -m chatty.demo_data" in text
        assert "uv sync --locked" in text
        assert "pnpm install --frozen-lockfile" in text
        assert "pnpm test:e2e" in text
        assert "/api/chatty" in text
        assert all(term not in lowered for term in ("control-plane", "outbox", "worker", "jobs"))

    chinese = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "简历项目" in chinese
    assert "生产" in chinese


def test_context_names_the_current_agent_harness_and_runtime_boundaries() -> None:
    context = (ROOT / "CONTEXT.md").read_text(encoding="utf-8")

    assert "`src/chatty/harness.py`" in context
    assert "`src/chatty/runtime.py`" in context
    assert "`trace_id`" in context
    assert "Playwright" in context


def test_agent_instructions_include_the_real_browser_gate() -> None:
    agent_guide = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    root_package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    web_package = json.loads((ROOT / "apps/web/package.json").read_text(encoding="utf-8"))
    playwright_config = (ROOT / "apps/web/playwright.config.ts").read_text(encoding="utf-8")

    assert "`pnpm test:e2e`" in agent_guide
    assert root_package["scripts"]["test:e2e"] == "pnpm --filter @chatty/web test:e2e"
    assert web_package["scripts"]["test:e2e"] == "playwright test"
    assert 'channel: "chrome"' in playwright_config


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
    for removed_gate in (
        "build:skeleton",
        "test:fullstack",
        "test:worker-integration",
        "test:coverage:core",
    ):
        assert removed_gate not in workflow


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
    assert "pnpm dev &" in workflow
    assert "http://127.0.0.1:3000/playground" in workflow
    assert '"dev": "pnpm --filter @chatty/web dev"' in package
