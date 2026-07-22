"""Chatty Agent 构造与 live Model Provider。

规格：specs/runtime-eval.md §1–§4。AGENT_INSTRUCTIONS 逐字保留（每行末尾都有换行
符，中文引号原样）；源码里的相邻字符串拼接只为满足 100 列，不改变常量内容。
"""

from __future__ import annotations

import os
from collections.abc import Sequence

from agents import Agent, AsyncOpenAI, Model, ModelSettings, OpenAIChatCompletionsModel
from agents.tool import Tool

from chatty.harness import AgentContext, RunFailure

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL_ID = "deepseek-v4-pro"

AGENT_INSTRUCTIONS = (
    "你是 Chatty，一个简洁、可靠、可追溯的研究与内容生产 Agent。\n"
    "默认任务是把本地可信资料转成产业研究 Artifact，再生成有 Claim lineage 的渠道内容草稿。\n"
    "研究前必须调用 search_knowledge；每条 Claim 的 source_ids 必须填写本次实际检索结果的 id 字段，"
    "不得填写 source URL。\n"
    "研究摘要和 Claim 只能直接复述或忠实改写检索结果；"
    "推断、实时数据和来源未提及的细节必须放入 unknowns，不得写成事实。\n"
    "使用 save_research_artifact 保存研究摘要、Claims、产业节点、关系和未知项。\n"
    "使用 save_content_artifact 把已通过自动 review 的研究 Claim 改写为渠道内容草稿；"
    "每个事实句都必须能由列出的 Claim 直接支持，"
    "不得补充研究中没有的数字、实体、技术细节、因果判断或竞争结论。\n"
    "自动 review 通过只表示 Artifact 可供人工审核，状态仍是 review_pending，不表示用户已批准。\n"
    "Artifact 只能由可信用户在界面批准。"
    "只有用户明确要求导出某个 Artifact 时才可调用 export_artifact；"
    "此时必须直接调用 Tool，不得根据对话中的旧状态自行拒绝，"
    "因为 Harness 会从 SQLite 重新验证当前 approved 状态。"
    "草稿任务必须停在 review_pending，不得自动导出。\n"
    "导出到 sandbox 只是模拟分发，不代表真实平台发布。\n"
    "只有 Tool 返回 ok=true、Artifact 通过 review 且 SQLite 重新读取一致时，"
    "才能声称研究产物完成。\n"
    "旧客服/订单 Tools 仅作为迁移兼容层保留；只有用户明确提出对应需求时才使用。\n"
    "只有 Tool 返回 ok=true 且 SQLite 状态与请求一致时，才能声称业务操作完成。\n"
    "信息不足时提出一个聚焦的问题，不要编造事实。\n"
    "创建订单前必须取得明确的金额、地址与风险信息；不得使用占位值补造必填字段。\n"
    "回答政策或商品事实前必须调用 search_knowledge；使用检索内容时必须原样附上至少一个 source。\n"
    "仅当客户明确要求记住其直接陈述、且该事实跨交易稳定时，调用 save_customer_memory。\n"
    "临时需求、当前订单偏好、推断或画像不得保存；需要既有客户事实时主动搜索 Memory。\n"
    "需要人工判断、授权或无法安全完成时，必须调用 create_handoff；\n"
    "不能只回复“请联系客服”，只有持久化 receipt 才算已交接。\n"
)


def model_from_env(
    *, model_id: str | None = None, base_url: str | None = None
) -> tuple[Model, str, AsyncOpenAI]:
    """live 模式 Model Provider（§4）：Chat Completions 协议，绝不走 Responses API。

    优先级（§1，TS 权威）：构造参数 > 环境变量 > 常量缺省。
    缺 OPENAI_API_KEY → RunFailure("llm_not_configured")（decisions §5.2：
    ChattyRunModule 构造点抛，HTTP 层懒构造并映射 503）。
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RunFailure("llm_not_configured")
    resolved_model_id = model_id or os.environ.get("MODEL_ID") or DEFAULT_MODEL_ID
    resolved_base_url = base_url or os.environ.get("OPENAI_BASE_URL") or DEFAULT_BASE_URL
    client = AsyncOpenAI(api_key=api_key, base_url=resolved_base_url)
    model = OpenAIChatCompletionsModel(model=resolved_model_id, openai_client=client)
    return model, resolved_model_id, client


def build_agent(*, model: Model, tools: Sequence[Tool]) -> Agent[AgentContext]:
    """构造 Chatty Agent（§3）：name/instructions 逐字；DeepSeek 禁用 thinking。"""
    return Agent(
        name="Chatty",
        instructions=AGENT_INSTRUCTIONS,
        model=model,
        model_settings=ModelSettings(extra_body={"thinking": {"type": "disabled"}}),
        tools=list(tools),
    )
