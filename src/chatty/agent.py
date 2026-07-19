from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

from agents import (
    Agent,
    AsyncOpenAI,
    Model,
    ModelSettings,
    OpenAIChatCompletionsModel,
    RunConfig,
    Runner,
    SQLiteSession,
    function_tool,
)
from pydantic import Field

from chatty.knowledge import KnowledgeRecord, KnowledgeStore
from agents.tool import Tool

from chatty.commerce import CommerceStore
from chatty.order_tools import BusinessOutcome, HarnessContext, build_order_tools

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL_ID = "deepseek-v4-pro"

AGENT_INSTRUCTIONS = """你是 Chatty，一个简洁、可靠的客服 Agent。
直接理解用户消息，由你选择合适的 Tool 查询库存、查看或更改订单。
只有 Tool 返回 ok=true 且 SQLite 状态与请求一致时，才能声称业务操作完成。
信息不足时提出一个聚焦的问题，不要编造事实。
回答政策或商品事实前必须调用 search_knowledge；使用检索内容时必须原样附上至少一个 source。
"""


class MissingApiKeyError(RuntimeError):
    pass


class InvalidAgentOutputError(RuntimeError):
    pass


@dataclass(frozen=True)
class AgentRunResult:
    reply: str
    knowledge_search_results: list[KnowledgeRecord]
    business_outcome: BusinessOutcome
    completion_evidence: str


def model_from_env() -> tuple[Model, str]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise MissingApiKeyError("OPENAI_API_KEY is required")
    model_id = os.getenv("MODEL_ID", DEFAULT_MODEL_ID)
    client = AsyncOpenAI(
        api_key=api_key,
        base_url=os.getenv("OPENAI_BASE_URL", DEFAULT_BASE_URL),
    )
    return OpenAIChatCompletionsModel(model=model_id, openai_client=client), model_id


async def run_agent(
    *,
    message: str,
    session_id: str,
    database_path: str | Path,
    model: Model,
    model_id: str,
    trace_id: str,
    knowledge_store: KnowledgeStore,
    customer_id: str,
    commerce: CommerceStore,
) -> AgentRunResult:
    knowledge_search_results: dict[str, KnowledgeRecord] = {}

    @function_tool
    def search_knowledge(
        query: Annotated[str, Field(min_length=1, max_length=500)],
        limit: Annotated[int, Field(ge=1, le=5)] = 3,
    ) -> str:
        """Search seller-verified policy and product knowledge.

        Args:
            query: Model-selected lexical query.
            limit: Maximum number of structured source records to return.
        """
        search_result = knowledge_store.search(query, limit=limit)
        for record in search_result.results:
            knowledge_search_results[record.id] = record
        return search_result.model_dump_json()

    agent_tools: list[Tool] = [search_knowledge, *build_order_tools()]
    agent: Agent[HarnessContext] = Agent(
        name="Chatty",
        instructions=AGENT_INSTRUCTIONS,
        model=model,
        model_settings=ModelSettings(extra_body={"thinking": {"type": "disabled"}}),
        tools=agent_tools,
    )
    session = SQLiteSession(
        session_id,
        db_path=database_path,
        sessions_table="chatty_sessions",
        messages_table="chatty_messages",
    )
    harness_context = HarnessContext(
        customer_id=customer_id,
        session_id=session_id,
        commerce=commerce,
    )
    try:
        result = await Runner.run(
            agent,
            message,
            context=harness_context,
            session=session,
            run_config=RunConfig(
                workflow_name="Chatty Agent Run",
                trace_id=trace_id,
                group_id=session_id,
                trace_metadata={"model_id": model_id},
                trace_include_sensitive_data=False,
            ),
        )
    finally:
        session.close()
    if not isinstance(result.final_output, str) or not result.final_output.strip():
        raise InvalidAgentOutputError("Agent returned no customer-facing reply")
    if knowledge_search_results and not any(
        record.source in result.final_output for record in knowledge_search_results.values()
    ):
        raise InvalidAgentOutputError("Knowledge-backed reply omitted its source")
    business_outcome, completion_evidence = harness_context.verify_business_outcome()
    reply = result.final_output
    if business_outcome == "not_completed":
        error_code = completion_evidence.partition(":")[2] or "business_tool_failed"
        reply = f"业务操作未完成：{error_code}"
    return AgentRunResult(
        reply=reply,
        knowledge_search_results=list(knowledge_search_results.values()),
        business_outcome=business_outcome,
        completion_evidence=completion_evidence,
    )
