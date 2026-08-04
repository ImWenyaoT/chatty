from __future__ import annotations

from agents import OpenAIResponsesModel, set_tracing_disabled
from openai import AsyncOpenAI

from app.settings import Settings, load_settings


class MissingCredentialsError(Exception):
    pass


class ResponsesModelProvider:
    """Task Framer 和主 Agent Loop 共用同一个 DeepSeek Responses 客户端。"""

    def __init__(self, settings: Settings | None = None) -> None:
        resolved_settings = settings or load_settings()
        self.model_id = resolved_settings.model
        self.configured = bool(resolved_settings.api_key)
        self.client = AsyncOpenAI(
            api_key=resolved_settings.api_key or "not-configured",
            base_url=resolved_settings.base_url,
        )
        self.agent_model = OpenAIResponsesModel(
            model=self.model_id,
            openai_client=self.client,
        )
        # DeepSeek 不接收 OpenAI trace，因此关闭 SDK 默认 tracing。
        set_tracing_disabled(True)

    async def close(self) -> None:
        await self.client.close()
