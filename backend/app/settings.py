from __future__ import annotations

import os
from pathlib import Path

from dotenv import dotenv_values
from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIST = ROOT / "frontend" / "dist"


class Settings(BaseSettings):
    """Chatty 运行配置。

    本地文件是显式配置，因此优先级为 .env.local > .env > 系统环境变量。
    """

    model_config = SettingsConfigDict(extra="ignore", populate_by_name=True)

    api_key: str = Field(
        default="",
        validation_alias=AliasChoices("DEEPSEEK_API_KEY", "OPENAI_API_KEY"),
    )
    base_url: str = Field(
        default="https://api.deepseek.com",
        validation_alias=AliasChoices("DEEPSEEK_BASE_URL", "OPENAI_BASE_URL"),
    )
    model: str = Field(
        default="deepseek-v4-flash",
        validation_alias=AliasChoices("DEEPSEEK_MODEL", "MODEL_ID"),
    )
    port: int = Field(default=8000, validation_alias="PORT")


def load_settings(root: Path = ROOT) -> Settings:
    values: dict[str, str] = dict(os.environ)

    # 后读取的文件覆盖前面的值，所以最终优先级是
    # .env.local > .env > 系统环境变量。
    for path in (root / ".env", root / ".env.local"):
        file_values = dotenv_values(path)
        for key, value in file_values.items():
            if value is not None:
                values[key] = value
    return Settings.model_validate(values)
