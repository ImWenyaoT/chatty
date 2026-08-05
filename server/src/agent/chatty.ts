/**
 * Chatty 的外层 Harness：理解任务、执行 Agent，并整理本轮状态。
 *
 * 一次请求的数据流：
 *
 * 用户原话 + 上一轮待澄清内容
 *     -> Task Framer 把自然语言整理成 TaskFrame
 *     -> Harness 从 SQLite 准备确定性的 TaskContext
 *     -> ChattyExecutor 运行主 Agent，调用 Tool 并校验 Evidence
 *     -> ChattyTurn 把回复、新 Context、Trace 和 Usage 一起交还 HTTP 层
 *
 * Model 负责理解和生成；这个文件负责调用顺序、错误边界和 Context In/Out。
 */

import {
  MaxTurnsExceededError,
  ModelBehaviorError,
  ModelRefusalError,
  Usage,
  run,
  type AgentInputItem,
} from "@openai/agents";

import { Catalog, CatalogError } from "../data/catalog.ts";
import type { Reply } from "../data/models.ts";
import { MissingCredentialsError, type ModelProvider } from "../model-provider.ts";
import { createEvidence, type RecommendationEvidence } from "./evidence.ts";
import { ChattyExecutor, RecommendationError, prepareTaskContext } from "./executor.ts";
import {
  TaskFrameParseError,
  buildTaskFrameAgent,
  describeTaskFrame,
  parseTaskFrame,
  recoverInvalidTaskFrame,
} from "./framing.ts";

export const MAX_TURNS = 3;

/**
 * 一次会话中需要带入下一轮的最小状态。
 *
 * pendingUserMessages 给 Task Framer 看，让“200 元左右”这种短回答能补全上一轮问题；
 * history 给主 Agent 看，避免它忘记自己问过什么；turns 用来限制澄清次数。
 * 一旦给出完整回答或推荐，这些内容就会清空。
 */
export type ChattyContext = {
  pendingUserMessages: string[];
  history: AgentInputItem[];
  turns: number;
};

export function createChattyContext(): ChattyContext {
  return { pendingUserMessages: [], history: [], turns: 0 };
}

/** `run()` 的完整输出，HTTP 层只需要认识这一个结果对象。 */
export type ChattyTurn = {
  // reply 是用户真正看到的领域结果：回答、推荐或澄清问题。
  reply: Reply;
  // understoodAs 用于 UI 展示 Task Framer 怎样理解了用户原话。
  understoodAs: string;
  // context 必须由调用方保存，并在下一轮原样传回。
  context: ChattyContext;
  turnsLeft: number;
  // trace、usage 和 latencyMs 只用于解释与观察，不参与业务判断。
  trace: string[];
  usage: Usage;
  latencyMs: number;
};

/** Chatty 对外只暴露稳定错误码，底层异常通过 cause 保留。 */
export class ChattyError extends Error {
  readonly code: string;
  readonly diagnostics: Record<string, unknown>;

  constructor(code: string, diagnostics: Record<string, unknown> = {}, cause?: unknown) {
    super(code, { cause });
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

/** HTTP 层依赖的最小 Interface；测试可传入实现相同方法的 Fake。 */
export type ChattyAgent = {
  run(userId: string, text: string, context: ChattyContext): Promise<ChattyTurn>;
};

/**
 * Chatty Agent 的单一外部 Interface；内部包含 Model 与 Harness。
 *
 * Chatty 本身不保存用户会话。HTTP 层传入旧 ChattyContext，本方法返回新 ChattyContext，
 * 因此状态的所有权始终清楚，也方便测试单独执行任意一轮。
 */
export class Chatty implements ChattyAgent {
  readonly #catalog: Catalog;
  readonly #provider: ModelProvider;
  readonly #executor: ChattyExecutor;

  constructor(catalog: Catalog, provider: ModelProvider) {
    this.#catalog = catalog;
    this.#provider = provider;
    this.#executor = new ChattyExecutor(catalog, provider);
  }

  /** 完成一轮 Context In / Context Out。 */
  async run(userId: string, text: string, context: ChattyContext): Promise<ChattyTurn> {
    // 计时覆盖 Task Framer 和主 Agent，表示用户等待这一整轮的时间。
    const started = performance.now();

    // turns 在进入模型前检查，避免已经耗尽的会话继续产生费用。
    if (context.turns >= MAX_TURNS) throw new ChattyError("conversation_exhausted");

    // Task Framer 需要看到所有待补全的原话；主 Agent 仍只接收当前 text 和 history。
    const pendingMessages = [...context.pendingUserMessages, text];
    // Evidence 是本轮新建的 Harness 账本。它不会跨轮累积，也不会由 Model 填写。
    const evidence = createEvidence();

    try {
      if (!this.#provider.configured)
        throw new MissingCredentialsError("llm_not_configured");

      // 第一步只把自然语言整理成业务字段，不搜索商品，也不生成答案。
      const frameResult = await run(
        buildTaskFrameAgent(this.#provider, this.#catalog.categories),
        pendingMessages
          .map((message, index) => `用户第${index + 1}轮：${message}`)
          .join("\n"),
        {
          maxTurns: 1,
          errorHandlers: { invalidFinalOutput: recoverInvalidTaskFrame },
        },
      );
      if (frameResult.finalOutput === undefined) {
        throw new TaskFrameParseError("invalid_task_frame_output");
      }
      const frame = parseTaskFrame(frameResult.finalOutput, this.#catalog.categories);

      // 第二步先从 SQLite 准备画像、候选和库存等确定性 Context，再运行主 Agent。
      const taskContext = prepareTaskContext(frame, userId, this.#catalog, evidence);
      const reply = await this.#executor.respond(
        taskContext,
        evidence,
        text,
        context.history,
      );

      // 一轮会调用两个 Model：Task Framer 和主 Agent，所以在这里合并 Usage。
      const usage = new Usage();
      usage.add(frameResult.state.usage);
      usage.add(evidence.usage);

      // 默认清空 Context。只有澄清尚未完成时，才保留待补全内容。
      const clarifying = reply.kind === "clarify";
      const nextContext: ChattyContext = {
        pendingUserMessages: clarifying ? pendingMessages : [],
        history: clarifying
          ? [
              ...context.history,
              ...clarificationHistory(text, reply.question, reply.answer),
            ]
          : [],
        turns: context.turns + 1,
      };

      return {
        reply,
        understoodAs: describeTaskFrame(frame),
        context: nextContext,
        turnsLeft: MAX_TURNS - nextContext.turns,
        trace: traceSteps(evidence),
        usage,
        latencyMs: performance.now() - started,
      };
    } catch (error) {
      // 把不同依赖的异常翻译成少量稳定错误码，HTTP 层不需要认识 SDK 异常。
      throw toChattyError(error);
    }
  }
}

function toChattyError(error: unknown): ChattyError {
  if (error instanceof ChattyError) return error;
  if (error instanceof MissingCredentialsError) {
    return new ChattyError("llm_not_configured", {}, error);
  }
  if (
    error instanceof TaskFrameParseError ||
    error instanceof MaxTurnsExceededError ||
    error instanceof ModelBehaviorError ||
    error instanceof ModelRefusalError
  ) {
    return new ChattyError("task_frame_parse_failed", {}, error);
  }
  if (error instanceof RecommendationError) {
    return new ChattyError(error.code, error.diagnostics, error);
  }
  if (error instanceof CatalogError) return new ChattyError(error.message, {}, error);
  throw error;
}

/** 把 Harness 真实记录过的 Tool 整理成适合 UI 展示的简短 Trace。 */
function traceSteps(evidence: RecommendationEvidence): string[] {
  // 同一个 Tool 可能重试多次，UI 只展示它是否参与过，不展示重复名称。
  const steps = ["task_framing", ...new Set(evidence.used_tools)];
  steps.push("response_generation", "evidence_validation");
  return steps;
}

/**
 * 把本轮澄清转换成 Agents SDK 下一轮可读取的消息格式。
 *
 * 保存结构化 action、question 和 answer，而不是整份 RunResult；这样下一轮既知道
 * Agent 问过什么，也不会把上一轮的 Tool Result 和临时 Evidence 全部带进去。
 */
function clarificationHistory(
  userText: string,
  question: string,
  answer: string | null,
): AgentInputItem[] {
  return [
    { role: "user", content: [{ type: "input_text", text: userText }] },
    {
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: JSON.stringify({ action: "clarify", question, answer }),
        },
      ],
    },
  ];
}
