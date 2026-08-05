/**
 * 按脚本回放的 Model，用来在不联网的情况下驱动真实 Runner。
 *
 * 测试通过它验证 Harness 行为：Tool 门禁、Evidence 校验和错误码。
 * 用假 Model 而不是替换 Runner，可以保证 guardrail 与 input filter 也真实执行。
 */

import {
  Usage,
  setTracingDisabled,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents";
import type { AgentOutputItem } from "@openai/agents";

// 测试不产生真实 trace，也不需要 OpenAI 凭据。
setTracingDisabled(true);

export function textOutput(text: string): AgentOutputItem[] {
  return [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  ];
}

export function toolCalls(
  calls: readonly { callId: string; name: string; args: unknown }[],
): AgentOutputItem[] {
  return calls.map((call) => ({
    type: "function_call",
    callId: call.callId,
    name: call.name,
    status: "completed",
    arguments: JSON.stringify(call.args),
  }));
}

export class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];
  #turns: AgentOutputItem[][];

  constructor(turns: readonly AgentOutputItem[][]) {
    this.#turns = [...turns];
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const output = this.#turns.shift();
    if (output === undefined) throw new Error("scripted_model_exhausted");
    return {
      usage: new Usage({
        requests: 1,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      }),
      output,
    };
  }

  getStreamedResponse(): AsyncIterable<never> {
    throw new Error("streaming_not_supported_in_tests");
  }
}
