from __future__ import annotations

import json
import os
from dataclasses import asdict
from typing import Annotated, Literal

from agents import (
    Agent,
    AsyncOpenAI,
    Model,
    ModelSettings,
    OpenAIChatCompletionsModel,
    RunConfig,
    RunContextWrapper,
    Runner,
    SQLiteSession,
    function_tool,
)
from agents.exceptions import MaxTurnsExceeded, ModelBehaviorError
from agents.tool import Tool
from pydantic import Field, StringConstraints

from chatty.harness import (
    AgentContext,
    AgentRunResult,
    MemoryEvent,
    complete_agent_run,
    create_handoff,
    force_handoff,
    persist_agent_run,
)
from chatty.knowledge import KnowledgeRecord, KnowledgeStore
from chatty.order_tools import build_order_tools

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL_ID = "deepseek-v4-pro"

AGENT_INSTRUCTIONS = """你是 Chatty，一个简洁、可靠的客服 Agent。
直接理解用户消息，由你选择合适的 Tool 查询库存、查看或更改订单。
只有 Tool 返回 ok=true 且 SQLite 状态与请求一致时，才能声称业务操作完成。
信息不足时提出一个聚焦的问题，不要编造事实。
创建订单前必须取得明确的金额、地址与风险信息；不得使用占位值补造必填字段。
回答政策或商品事实前必须调用 search_knowledge；使用检索内容时必须原样附上至少一个 source。
仅当客户明确要求记住其直接陈述、且该事实跨交易稳定时，调用 save_customer_memory。
临时需求、当前订单偏好、推断或画像不得保存；需要既有客户事实时主动搜索 Memory。
需要人工判断、授权或无法安全完成时，必须调用 create_handoff；
不能只回复“请联系客服”，只有持久化 receipt 才算已交接。
"""


class MissingApiKeyError(RuntimeError):
    pass


def memory_tools() -> list[Tool]:
    @function_tool(use_docstring_info=False)
    async def save_customer_memory(
        context: RunContextWrapper[AgentContext],
        fact: Annotated[
            str,
            StringConstraints(strip_whitespace=True, min_length=1, max_length=500),
        ],
        explicitly_stated: Literal[True],
        stable: Literal[True],
    ) -> str:
        try:
            fact = fact.strip()
            if not fact:
                raise ValueError("memory fact must not be blank")
            if fact.casefold() not in context.context.message.casefold():
                raise ValueError("memory fact must be a verbatim part of the customer message")
            memory = context.context.memory_store.save(
                customer_id=context.context.customer_id,
                fact=fact,
                source_id=context.context.trace_id,
            )
        except Exception:
            context.context.prior_actions.append("save_customer_memory:failed")
            raise
        event = MemoryEvent(tool="save_customer_memory", memories=[memory])
        context.context.memory_events.append(event)
        context.context.prior_actions.append("save_customer_memory:ok")
        return json.dumps(
            {"tool": event.tool, "memories": [asdict(memory)]},
            ensure_ascii=False,
        )

    @function_tool(use_docstring_info=False)
    async def search_customer_memory(
        context: RunContextWrapper[AgentContext],
        query: Annotated[
            str,
            StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
        ],
        limit: Annotated[int, Field(ge=1, le=10)] = 5,
    ) -> str:
        try:
            query = query.strip()
            if not query:
                raise ValueError("memory query must not be blank")
            memories = context.context.memory_store.search(
                customer_id=context.context.customer_id,
                query=query,
                limit=limit,
            )
        except Exception:
            context.context.prior_actions.append("search_customer_memory:failed")
            raise
        event = MemoryEvent(tool="search_customer_memory", memories=memories)
        context.context.memory_events.append(event)
        context.context.prior_actions.append("search_customer_memory:ok")
        return json.dumps(
            {"tool": event.tool, "memories": [asdict(memory) for memory in memories]},
            ensure_ascii=False,
        )

    return [search_customer_memory, save_customer_memory]


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
    model: Model,
    model_id: str,
    context: AgentContext,
    knowledge_store: KnowledgeStore,
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
        context.prior_actions.append(f"search_knowledge:{search_result.status}")
        for record in search_result.results:
            knowledge_search_results[record.id] = record
        return search_result.model_dump_json()

    agent_tools: list[Tool] = [
        search_knowledge,
        *memory_tools(),
        *build_order_tools(),
        create_handoff,
    ]
    agent: Agent[AgentContext] = Agent(
        name="Chatty",
        instructions=AGENT_INSTRUCTIONS,
        model=model,
        model_settings=ModelSettings(extra_body={"thinking": {"type": "disabled"}}),
        tools=agent_tools,
    )
    session = SQLiteSession(
        context.session_id,
        db_path=context.memory_store.database_path,
        sessions_table="chatty_sessions",
        messages_table="chatty_messages",
    )
    try:
        try:
            result = await Runner.run(
                agent,
                context.message,
                context=context,
                session=session,
                run_config=RunConfig(
                    workflow_name="Chatty Agent Run",
                    trace_id=context.trace_id,
                    group_id=context.session_id,
                    trace_metadata={"model_id": model_id},
                    trace_include_sensitive_data=False,
                ),
            )
        except ModelBehaviorError:
            context.prior_actions.append("model_tool_call:rejected")
            return persist_agent_run(
                context,
                force_handoff(
                    context,
                    reason="Harness 拒绝无效操作",
                    details="Model 请求了无效或不可用的 Tool",
                    knowledge_search_results=knowledge_search_results,
                ),
            )
        except MaxTurnsExceeded:
            context.prior_actions.append("agent_loop:max_turns")
            return persist_agent_run(
                context,
                force_handoff(
                    context,
                    reason="Harness 安全恢复已耗尽",
                    details="Agent 在受限 turns 内未完成处理",
                    knowledge_search_results=knowledge_search_results,
                ),
            )
    finally:
        session.close()
    return persist_agent_run(
        context,
        complete_agent_run(
            context,
            final_output=result.final_output,
            interruptions=result.interruptions,
            new_items=result.new_items,
            knowledge_search_results=knowledge_search_results,
        ),
    )
