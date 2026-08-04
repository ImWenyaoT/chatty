"""把 Harness Evidence 投影为模型可见状态，并约束下一批 Tool 调用。"""

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
    NEED_SUPPORT = "need_support"
    READY_TO_DRAFT = "ready_to_draft"


@dataclass(frozen=True)
class GateDecision:
    allowed: bool
    reason: str | None = None


@dataclass(frozen=True)
class ToolBatch:
    stage: WorkflowStage
    decisions: dict[str, GateDecision]


def stage_for(evidence: RecommendationEvidence) -> WorkflowStage:
    """Evidence 是唯一状态源；阶段不单独持久化，避免两份状态漂移。"""

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
    used = set(evidence.used_tools)
    allowed: list[str] = []
    if evidence.used_tools.count("retrieve_knowledge") < 3:
        allowed.append("retrieve_knowledge")
    if (
        "get_marketing_strategy" in evidence.required_support_tools
        and "get_marketing_strategy" not in used
    ):
        allowed.append("get_marketing_strategy")
    return tuple(allowed)


def plan_tool_batch(
    evidence: RecommendationEvidence,
    calls: list[tuple[str, str]],
) -> ToolBatch:
    """在 Tool 执行前冻结整批决策，避免并发调用依赖完成先后顺序。"""

    stage = stage_for(evidence)
    allowed = set(allowed_tools(evidence))
    accepted: set[str] = set()
    decisions: dict[str, GateDecision] = {}
    for call_id, tool_name in calls:
        if tool_name not in allowed:
            decisions[call_id] = GateDecision(False, "tool_not_allowed_in_stage")
        elif tool_name in accepted:
            decisions[call_id] = GateDecision(False, "duplicate_tool_in_batch")
        else:
            decisions[call_id] = GateDecision(True)
            accepted.add(tool_name)
    return ToolBatch(stage=stage, decisions=decisions)


def render_agent_status(evidence: RecommendationEvidence) -> str:
    """只披露进度与下一步，不把 Harness-owned Evidence 交给模型。"""

    stage = stage_for(evidence)
    completed = ", ".join(dict.fromkeys(evidence.used_tools)) or "none"
    required_scopes = ", ".join(evidence.required_knowledge_scopes) or "none"
    completed_scopes = ", ".join(sorted(evidence.completed_knowledge_scopes)) or "none"
    next_steps = list(allowed_tools(evidence))
    if stage is WorkflowStage.READY_TO_DRAFT:
        next_steps.append("final_output")
    allowed = ", ".join(next_steps)
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
    """每轮重新追加状态快照，不改写原始对话 Context。"""

    if data.context is None:
        return data.model_data
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
    async def on_llm_end(self, context: Any, agent: Any, response: Any) -> None:
        del agent
        calls = [
            (item.call_id, item.name)
            for item in response.output
            if isinstance(item, ResponseFunctionToolCall)
        ]
        batch = plan_tool_batch(context.context.evidence, calls)
        context.context.batch_stage = batch.stage
        context.context.batch_decisions = batch.decisions


@tool_input_guardrail(name="chatty_stage_gate")
async def stage_guardrail(
    data: ToolInputGuardrailData,
) -> ToolGuardrailFunctionOutput:
    """执行 Hook 已冻结的批次决策，并把拒绝原因返回模型。"""

    tool_context = data.context
    run_context = tool_context.context
    decision = run_context.batch_decisions.get(tool_context.tool_call_id)
    if decision is not None and decision.allowed:
        stage = run_context.batch_stage or stage_for(run_context.evidence)
        return ToolGuardrailFunctionOutput.allow({"stage_snapshot": stage.value})

    reason = "unplanned_tool_call"
    if decision is not None and decision.reason is not None:
        reason = decision.reason
    stage = run_context.batch_stage or stage_for(run_context.evidence)
    run_context.evidence.blocked_attempts.append(
        f"{stage.value}:{tool_context.tool_name}:{reason}"
    )
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
