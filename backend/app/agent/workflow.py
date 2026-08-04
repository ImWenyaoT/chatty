"""把 Harness Evidence 投影为模型可见状态，并约束下一批 Tool 调用。

主 Agent 可能一次提出多个 Tool call。这个文件在 Tool 真正执行前，根据 Evidence 为整批
调用做决定：哪些允许、哪些重复、哪些当前阶段不能调用。决定会返回 Model，让它下一轮
可以自行纠正；Harness 不依靠 Model 对自身调用历史的描述。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from agents import RunHooks
from agents.run_config import CallModelData, ModelInputData
from agents.tool_guardrails import (
    ToolGuardrailFunctionOutput,
    ToolInputGuardrailData,
    tool_input_guardrail,
)
from openai.types.responses import ResponseFunctionToolCall

from app.agent.evidence import RecommendationEvidence


class WorkflowStage(StrEnum):
    """Agent Loop 只有两个阶段：补齐支撑材料，或者已经可以生成草稿。"""

    NEED_SUPPORT = "need_support"
    READY_TO_DRAFT = "ready_to_draft"


@dataclass(frozen=True)
class GateDecision:
    """单个 Tool call 的门禁结果。frozen=True 表示创建后不能修改字段。"""

    allowed: bool
    reason: str | None = None


@dataclass(frozen=True)
class ToolBatch:
    """同一次 Model 响应中全部 Tool call 的冻结决策。"""

    stage: WorkflowStage
    decisions: dict[str, GateDecision]


def stage_for(evidence: RecommendationEvidence) -> WorkflowStage:
    """Evidence 是唯一状态源；阶段不单独持久化，避免两份状态漂移。"""

    # 转成 set 后只关心“是否完成”，不关心同一 Tool 调用了几次。
    used = set(evidence.used_tools)
    support = set(evidence.required_support_tools)
    if not support.issubset(used):
        return WorkflowStage.NEED_SUPPORT
    if not set(evidence.required_knowledge_scopes).issubset(
        evidence.completed_knowledge_scopes
    ):
        return WorkflowStage.NEED_SUPPORT
    return WorkflowStage.READY_TO_DRAFT


def allowed_tools(evidence: RecommendationEvidence) -> tuple[str, ...]:
    """返回当前 Evidence 状态下 Model 下一步可以调用的 Tool 名称。"""

    used = set(evidence.used_tools)
    allowed: list[str] = []

    # 知识检索允许改写 query 重试，但整个 Agent Loop 最多三次。
    if evidence.used_tools.count("retrieve_knowledge") < 3:
        allowed.append("retrieve_knowledge")
    if (
        "get_marketing_strategy" in evidence.required_support_tools
        and "get_marketing_strategy" not in used
    ):
        allowed.append("get_marketing_strategy")
    # tuple 表示调用方不应该原地修改这个结果。
    return tuple(allowed)


def plan_tool_batch(
    evidence: RecommendationEvidence,
    calls: list[tuple[str, str]],
) -> ToolBatch:
    """在 Tool 执行前冻结整批决策，避免并发调用依赖完成先后顺序。"""

    # 在任何 Tool 开始前读取一次 Evidence，整批调用都基于同一个快照做决定。
    stage = stage_for(evidence)
    allowed = set(allowed_tools(evidence))
    accepted: set[str] = set()
    decisions: dict[str, GateDecision] = {}
    # calls 中每项是 `(SDK 生成的 call_id, Tool 名称)`。
    for call_id, tool_name in calls:
        if tool_name not in allowed:
            decisions[call_id] = GateDecision(False, "tool_not_allowed_in_stage")
        elif tool_name in accepted:
            # 同一批重复 Tool 看不到彼此结果，所以只允许第一个执行。
            decisions[call_id] = GateDecision(False, "duplicate_tool_in_batch")
        else:
            decisions[call_id] = GateDecision(True)
            accepted.add(tool_name)
    return ToolBatch(stage=stage, decisions=decisions)


def render_agent_status(evidence: RecommendationEvidence) -> str:
    """只披露进度与下一步，不把 Harness-owned Evidence 交给模型。

    返回普通字符串而不是 Python 对象，因为它会作为 developer message
    加入 Model Context。
    商品 ID、画像详情等真实 Evidence 不放进去，避免 Model 反过来篡改 Harness 判断。
    """

    stage = stage_for(evidence)
    # dict.fromkeys 保留首次出现顺序，同时去掉重复 Tool 名称。
    completed = ", ".join(dict.fromkeys(evidence.used_tools)) or "none"
    required_scopes = ", ".join(evidence.required_knowledge_scopes) or "none"
    completed_scopes = ", ".join(sorted(evidence.completed_knowledge_scopes)) or "none"
    next_steps = list(allowed_tools(evidence))
    if stage is WorkflowStage.READY_TO_DRAFT:
        next_steps.append("final_output")
    allowed = ", ".join(next_steps)
    # version 不是数据库版本，只是让 Model 看出状态是否比上一轮有进展。
    version = len(evidence.used_tools) + len(evidence.blocked_attempts)
    return (
        f'<agent_status version="{version}">\n'
        f"stage: {stage.value}\n"
        f"completed_steps: {completed}\n"
        f"required_knowledge_scopes: {required_scopes}\n"
        f"completed_knowledge_scopes: {completed_scopes}\n"
        f"allowed_next: {allowed}\n"
        f"blocked_attempts: {len(evidence.blocked_attempts)}\n"
        "</agent_status>"
    )


def append_agent_status(data: CallModelData[Any]) -> ModelInputData:
    """每轮重新追加状态快照，不改写原始对话 Context。

    `Any` 出现在这里是因为 Agents SDK 的 Hook 类型没有暴露具体泛型；进入项目自己的
    ChattyRunContext 后，字段仍然有明确类型。它不是让业务数据随意流动。
    """

    if data.context is None:
        return data.model_data
    # status_item 使用 Responses API 的 developer message 形状。
    status_item: Any = {
        "role": "developer",
        "content": [
            {
                "type": "input_text",
                "text": render_agent_status(data.context.evidence),
            }
        ],
    }
    return ModelInputData(
        input=[*data.model_data.input, status_item],
        instructions=data.model_data.instructions,
    )


class ChattyRunHooks(RunHooks[Any]):
    """Model 每次返回后，先收集 Tool calls，再为这一整批生成门禁决策。"""

    async def on_llm_end(self, context: Any, agent: Any, response: Any) -> None:
        # Hook Interface 要求接收 agent，但当前逻辑不使用它；del 明确说明不是遗漏。
        del agent

        # response.output 还可能包含文本，只挑选真正的 function tool call。
        calls = [
            (item.call_id, item.name)
            for item in response.output
            if isinstance(item, ResponseFunctionToolCall)
        ]
        # 决策写进 ChattyRunContext，随后每个 Tool 的 guardrail 会按 call_id 读取。
        batch = plan_tool_batch(context.context.evidence, calls)
        context.context.batch_stage = batch.stage
        context.context.batch_decisions = batch.decisions


@tool_input_guardrail(name="chatty_stage_gate")
async def stage_guardrail(
    data: ToolInputGuardrailData,
) -> ToolGuardrailFunctionOutput:
    """执行 Hook 已冻结的批次决策，并把拒绝原因返回模型。"""

    # tool_context 是 SDK 包装；run_context 才是项目定义的 ChattyRunContext。
    tool_context = data.context
    run_context = tool_context.context
    decision = run_context.batch_decisions.get(tool_context.tool_call_id)
    if decision is not None and decision.allowed:
        # allow 的 output_info 只用于观察，不会成为 Tool 的业务参数。
        stage = run_context.batch_stage or stage_for(run_context.evidence)
        return ToolGuardrailFunctionOutput.allow({"stage_snapshot": stage.value})

    # 找不到 call_id 表示这个 Tool 没有经过上一阶段的整批规划，默认拒绝。
    reason = "unplanned_tool_call"
    if decision is not None and decision.reason is not None:
        reason = decision.reason
    stage = run_context.batch_stage or stage_for(run_context.evidence)
    # 被拒绝的调用没有执行，但仍记录原因，方便 Trace 和下一轮状态显示。
    run_context.evidence.blocked_attempts.append(
        f"{stage.value}:{tool_context.tool_name}:{reason}"
    )
    # reject_content 会把这段结构化消息作为 Tool Result 返回 Model，让它自行修正。
    message = json.dumps(
        {
            "status": "blocked",
            "reason": reason,
            "required_next": list(allowed_tools(run_context.evidence)),
            "agent_status": render_agent_status(run_context.evidence),
        },
        ensure_ascii=False,
    )
    return ToolGuardrailFunctionOutput.reject_content(
        message=message,
        output_info={"call_id": tool_context.tool_call_id},
    )
