from __future__ import annotations

from agents import OpenAIResponsesModel, set_tracing_disabled
from openai import AsyncOpenAI

from app.settings import Settings, load_settings


class MissingCredentialsError(Exception):
    pass


class ResponsesModelProvider:
    """Need parser 和 Agent Loop 共用同一个 DeepSeek Responses 客户端。"""

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

    async def complete(self, prompt: str, instructions: str | None = None) -> str:
        if not self.configured:
            raise MissingCredentialsError("llm_not_configured")
        response = await self.client.responses.create(
            model=self.model_id,
            instructions=instructions,
            input=prompt,
            reasoning={"effort": "none"},
        )
        # Responses API 允许只有 Tool/Reasoning 输出，此时 output_text 可能为空。
        return response.output_text or ""

    async def close(self) -> None:
        await self.client.close()
