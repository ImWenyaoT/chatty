/**
 * 按脚本回放的 Model，用来在不联网的情况下驱动真实 generateText。
 *
 * 测试通过它验证 Harness 行为：Tool 门禁、Evidence 校验和错误码。
 */

import { MockLanguageModelV4 } from "ai/test";

const defaultUsage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 5,
    text: 5,
    reasoning: undefined,
  },
};

export type ScriptedGenerateResult = {
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "tool-call";
        toolCallId: string;
        toolName: string;
        input: string;
      }
  >;
  finishReason: { unified: "stop" | "tool-calls"; raw: undefined };
  usage: typeof defaultUsage;
  warnings: [];
};

export function textResponse(text: string): ScriptedGenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: undefined },
    usage: defaultUsage,
    warnings: [],
  };
}

export function toolCallResponse(
  calls: readonly {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }[],
): ScriptedGenerateResult {
  return {
    content: calls.map((call) => ({
      type: "tool-call" as const,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input:
        typeof call.input === "string"
          ? call.input
          : JSON.stringify(call.input),
    })),
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: defaultUsage,
    warnings: [],
  };
}

/** 兼容既有测试命名。 */
export function textOutput(text: string): ScriptedGenerateResult {
  return textResponse(text);
}

/** 兼容既有测试命名（callId / name / args）。 */
export function toolCalls(
  calls: readonly { callId: string; name: string; args: unknown }[],
): ScriptedGenerateResult {
  return toolCallResponse(
    calls.map((call) => ({
      toolCallId: call.callId,
      toolName: call.name,
      input: call.args,
    })),
  );
}

export class ScriptedModel extends MockLanguageModelV4 {
  constructor(turns: readonly ScriptedGenerateResult[]) {
    const queue = [...turns];
    super({
      doGenerate: async () => {
        const next = queue.shift();
        if (next === undefined) throw new Error("scripted_model_exhausted");
        return next;
      },
    });
  }

  /** 兼容旧测试：等价于 `doGenerateCalls`。 */
  get requests() {
    return this.doGenerateCalls;
  }
}
