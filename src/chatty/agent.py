from __future__ import annotations

import os
from pathlib import Path

from agents import (
    Agent,
    AsyncOpenAI,
    Model,
    ModelSettings,
    OpenAIChatCompletionsModel,
    RunConfig,
    Runner,
    SQLiteSession,
)

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL_ID = "deepseek-v4-pro"

AGENT_INSTRUCTIONS = """你是 Chatty，一个简洁、可靠的客服 Agent。
直接理解用户消息并回答，不要声称执行了当前没有提供的业务工具。
信息不足时提出一个聚焦的问题，不要编造事实。
"""


class MissingApiKeyError(RuntimeError):
    pass


class InvalidAgentOutputError(RuntimeError):
    pass


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
) -> str:
    agent = Agent(
        name="Chatty",
        instructions=AGENT_INSTRUCTIONS,
        model=model,
        model_settings=ModelSettings(extra_body={"thinking": {"type": "disabled"}}),
    )
    session = SQLiteSession(
        session_id,
        db_path=database_path,
        sessions_table="chatty_sessions",
        messages_table="chatty_messages",
    )
    try:
        result = await Runner.run(
            agent,
            message,
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
    return result.final_output
