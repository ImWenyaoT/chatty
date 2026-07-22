"""Browser-smoke ASGI 工厂（specs/http-contract.md §10、decisions §7.1）。

Playwright e2e 用确定性脚本模型替代真实 LLM：身份全部固定、启动时清空 e2e
数据库、并立即（非懒）构建 NativeRuntime 与 run 模块。
启动命令：`uv run uvicorn --factory chatty.browser_smoke:create_app --port 8100`。
"""

from __future__ import annotations

from fastapi import FastAPI

from chatty import config
from chatty.app import create_app as create_http_app
from chatty.eval import EvalModel, MessageScript, ScriptItem, ToolScript

# §10 六步脚本（逐字）：search → research → content → message → export → message。
# `$last_artifact_id` 由 EvalModel 在运行期替换为最近一次产生的 artifact id。
BROWSER_SMOKE_SCRIPT: list[ScriptItem] = [
    ToolScript(
        type="tool",
        call_id="browser-smoke-search",
        name="search_knowledge",
        arguments={"query": "高精地图 智能驾驶", "limit": 1},
    ),
    ToolScript(
        type="tool",
        call_id="browser-smoke-research",
        name="save_research_artifact",
        arguments={
            "idempotency_key": "browser-smoke-research",
            "title": "高精地图产业研究简报",
            "summary": "基于本地演示资料整理。",
            "claims": [
                {
                    "id": "claim-position",
                    "text": "高精地图连接定位、地图更新与智能驾驶应用。",
                    "source_ids": ["demo-industry-map"],
                }
            ],
            "nodes": [],
            "relations": [],
            "unknowns": ["演示资料不包含实时市场规模"],
        },
    ),
    ToolScript(
        type="tool",
        call_id="browser-smoke-content",
        name="save_content_artifact",
        arguments={
            "idempotency_key": "browser-smoke-content",
            "research_artifact_id": "$last_artifact_id",
            "title": "高精地图内容包",
            "channels": [
                {
                    "channel": "xiaohongshu",
                    "title": "高精地图如何支持智能驾驶",
                    "body": "从定位与地图更新理解产业链。",
                    "claim_ids": ["claim-position"],
                }
            ],
        },
    ),
    MessageScript(
        type="message",
        message_id="browser-smoke-message",
        text="研究简报和内容草稿已保存，等待人工批准。来源：demo://industry/high-definition-map",
    ),
    ToolScript(
        type="tool",
        call_id="browser-smoke-export",
        name="export_artifact",
        arguments={"artifact_id": "$last_artifact_id", "target": "sandbox"},
    ),
    MessageScript(
        type="message",
        message_id="browser-smoke-follow-up",
        text="内容包已导出到 sandbox，并生成 delivery receipt。来源：demo://industry/high-definition-map",
    ),
]


def create_app() -> FastAPI:
    """browser-smoke 应用工厂（uvicorn --factory 入口）。

    §10 构建步骤：清除 db/-wal/-shm → 固定身份 + 脚本模型的默认应用 →
    立即构建 runtime 与 run 模块（非懒）。
    """
    database_path = config.e2e_database_path()
    config.reset_database(database_path)
    app = create_http_app(
        database_path=database_path,
        knowledge_path=config.knowledge_path(),
        model=EvalModel(BROWSER_SMOKE_SCRIPT),
        model_id="browser-smoke-model",
        customer_identity=lambda: "browser-smoke-customer",
        reviewer_identity=lambda: "browser-smoke-reviewer",
        request_identity=lambda: "browser-smoke-request",
    )
    # §10 步骤 2：立即（非懒）构建 NativeRuntime 与 run 模块。
    app.state.services.run_module()
    return app
