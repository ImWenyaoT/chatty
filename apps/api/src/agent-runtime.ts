import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  Agent,
  MaxTurnsExceededError,
  ModelBehaviorError,
  OpenAIProvider,
  RunToolCallItem,
  Runner,
  ToolCallError,
  tool,
  withTrace,
  type Model,
  type RunContext,
} from "@openai/agents";
import {
  RunResponseSchema,
  type KnowledgeRecord,
  type RunRequest,
  type RunResponse,
} from "@chatty/contracts";
import {
  AgentContext,
  HandoffIdempotencyConflictError,
  HandoffPersistenceError,
  completeAgentRun,
  forceHandoff,
  persistAgentFailure,
  persistAgentRun,
} from "./harness.js";
import { NativeRuntime } from "./runtime.js";
import { installRuntimeTracing } from "./sdk-tracing.js";
import { SQLiteSession } from "./session.js";
import {
  availabilityInput,
  createOrderToolInput,
  executeChattyTool,
  exportArtifactInput,
  handoffInput,
  orderIdInput,
  saveContentArtifactInput,
  saveMemoryInput,
  saveResearchArtifactInput,
  searchKnowledgeInput,
  searchMemoryInput,
  type ChattyToolName,
  type ToolExecutionState,
} from "./tools.js";
import {
  SessionCustomerMismatchError,
  SessionNotFoundError,
} from "./stores.js";

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL_ID = "deepseek-v4-pro";

export const AGENT_INSTRUCTIONS = `你是 Chatty，一个简洁、可靠、可追溯的研究与内容生产 Agent。
默认任务是把本地可信资料转成产业研究 Artifact，再生成有 Claim lineage 的渠道内容草稿。
研究前必须调用 search_knowledge；每条 Claim 的 source_ids 必须填写本次实际检索结果的 id 字段，不得填写 source URL。
研究摘要和 Claim 只能直接复述或忠实改写检索结果；推断、实时数据和来源未提及的细节必须放入 unknowns，不得写成事实。
使用 save_research_artifact 保存研究摘要、Claims、产业节点、关系和未知项。
使用 save_content_artifact 把已通过自动 review 的研究 Claim 改写为渠道内容草稿；每个事实句都必须能由列出的 Claim 直接支持，不得补充研究中没有的数字、实体、技术细节、因果判断或竞争结论。
自动 review 通过只表示 Artifact 可供人工审核，状态仍是 review_pending，不表示用户已批准。
Artifact 只能由可信用户在界面批准。只有用户明确要求导出某个 Artifact 时才可调用 export_artifact；此时必须直接调用 Tool，不得根据对话中的旧状态自行拒绝，因为 Harness 会从 SQLite 重新验证当前 approved 状态。草稿任务必须停在 review_pending，不得自动导出。
导出到 sandbox 只是模拟分发，不代表真实平台发布。
只有 Tool 返回 ok=true、Artifact 通过 review 且 SQLite 重新读取一致时，才能声称研究产物完成。
旧客服/订单 Tools 仅作为迁移兼容层保留；只有用户明确提出对应需求时才使用。
只有 Tool 返回 ok=true 且 SQLite 状态与请求一致时，才能声称业务操作完成。
信息不足时提出一个聚焦的问题，不要编造事实。
创建订单前必须取得明确的金额、地址与风险信息；不得使用占位值补造必填字段。
回答政策或商品事实前必须调用 search_knowledge；使用检索内容时必须原样附上至少一个 source。
仅当客户明确要求记住其直接陈述、且该事实跨交易稳定时，调用 save_customer_memory。
临时需求、当前订单偏好、推断或画像不得保存；需要既有客户事实时主动搜索 Memory。
需要人工判断、授权或无法安全完成时，必须调用 create_handoff；
不能只回复“请联系客服”，只有持久化 receipt 才算已交接。
`;

type AgentSdkContext = {
  harness: AgentContext;
  runtime: NativeRuntime;
  state: ToolExecutionState;
};

export class RunFailure extends Error {
  constructor(
    readonly code: string,
    readonly traceId: string | null = null,
    readonly internalErrorName: string | null = null,
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
  }
}

function execute(
  name: ChattyToolName,
  input: unknown,
  runContext?: RunContext<AgentSdkContext>,
): string {
  if (runContext === undefined)
    throw new Error("Agent SDK context is required");
  return executeChattyTool(
    runContext.context.harness,
    runContext.context.runtime.knowledge,
    runContext.context.state,
    name,
    input,
  );
}

function toolError(name: ChattyToolName) {
  return (runContext: RunContext<unknown>, error: unknown): string => {
    const context = runContext.context as AgentSdkContext;
    context.harness.recordFailure(name, error);
    return JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  };
}

export function buildAgentTools() {
  return [
    tool<typeof searchKnowledgeInput, AgentSdkContext>({
      name: "search_knowledge",
      description: "Search seller-verified policy and product knowledge.",
      parameters: searchKnowledgeInput,
      errorFunction: toolError("search_knowledge"),
      execute: (input, context) => execute("search_knowledge", input, context),
    }),
    tool<typeof searchMemoryInput, AgentSdkContext>({
      name: "search_customer_memory",
      description: "Search explicit stable facts for the trusted customer.",
      parameters: searchMemoryInput,
      errorFunction: toolError("search_customer_memory"),
      execute: (input, context) =>
        execute("search_customer_memory", input, context),
    }),
    tool<typeof saveMemoryInput, AgentSdkContext>({
      name: "save_customer_memory",
      description: "Save one verbatim, explicit, stable customer fact.",
      parameters: saveMemoryInput,
      errorFunction: toolError("save_customer_memory"),
      execute: (input, context) =>
        execute("save_customer_memory", input, context),
    }),
    tool<typeof availabilityInput, AgentSdkContext>({
      name: "check_availability",
      description: "Check real SQLite inventory for a rental period or buyout.",
      parameters: availabilityInput,
      errorFunction: toolError("check_availability"),
      execute: (input, context) =>
        execute("check_availability", input, context),
    }),
    tool<typeof createOrderToolInput, AgentSdkContext>({
      name: "create_order",
      description:
        "Create one pending order using trusted customer and session identity.",
      parameters: createOrderToolInput,
      errorFunction: toolError("create_order"),
      execute: (input, context) => execute("create_order", input, context),
    }),
    tool<typeof orderIdInput, AgentSdkContext>({
      name: "view_order",
      description: "Read one order belonging to the trusted customer.",
      parameters: orderIdInput,
      errorFunction: toolError("view_order"),
      execute: (input, context) => execute("view_order", input, context),
    }),
    tool<typeof orderIdInput, AgentSdkContext>({
      name: "confirm_order",
      description:
        "Confirm a trusted customer's order and allocate inventory once.",
      parameters: orderIdInput,
      errorFunction: toolError("confirm_order"),
      execute: (input, context) => execute("confirm_order", input, context),
    }),
    tool<typeof orderIdInput, AgentSdkContext>({
      name: "cancel_order",
      description:
        "Cancel a trusted customer's order and release inventory once.",
      parameters: orderIdInput,
      errorFunction: toolError("cancel_order"),
      execute: (input, context) => execute("cancel_order", input, context),
    }),
    tool<typeof handoffInput, AgentSdkContext>({
      name: "create_handoff",
      description:
        "Create a traceable support receipt for human judgment or authorization.",
      parameters: handoffInput,
      errorFunction: toolError("create_handoff"),
      execute: (input, context) => execute("create_handoff", input, context),
    }),
    tool<typeof saveResearchArtifactInput, AgentSdkContext>({
      name: "save_research_artifact",
      description:
        "Persist and automatically review one grounded research artifact. Every source_ids value must be the id field returned by search_knowledge, not its source URL. A passing review leaves the artifact review_pending for trusted-user approval.",
      parameters: saveResearchArtifactInput,
      errorFunction: toolError("save_research_artifact"),
      execute: (input, context) =>
        execute("save_research_artifact", input, context),
    }),
    tool<typeof saveContentArtifactInput, AgentSdkContext>({
      name: "save_content_artifact",
      description:
        "Persist and review a channel content artifact grounded in one reviewed research artifact.",
      parameters: saveContentArtifactInput,
      errorFunction: toolError("save_content_artifact"),
      execute: (input, context) =>
        execute("save_content_artifact", input, context),
    }),
    tool<typeof exportArtifactInput, AgentSdkContext>({
      name: "export_artifact",
      description:
        "When the user explicitly asks to export an artifact, call this tool and let the Harness verify its current trusted-user approval from SQLite; do not rely on stale conversation state. Never call it while creating a draft or merely because automatic review passed.",
      parameters: exportArtifactInput,
      errorFunction: toolError("export_artifact"),
      execute: (input, context) => execute("export_artifact", input, context),
    }),
  ];
}

export class ChattyRunModule {
  private readonly runner: Runner;
  private readonly agent: Agent<AgentSdkContext>;
  private readonly tracing = installRuntimeTracing();
  private readonly provider: OpenAIProvider | null;

  constructor(
    private readonly runtime: NativeRuntime,
    options: {
      model?: Model;
      modelId?: string;
      apiKey?: string;
      baseUrl?: string;
      knowledgePath?: string;
    } = {},
  ) {
    const modelId = options.modelId ?? process.env.MODEL_ID ?? DEFAULT_MODEL_ID;
    this.modelId = modelId;
    this.runtime.knowledge.importJsonl(
      options.knowledgePath ??
        resolve(import.meta.dirname, "../../../knowledge/records.jsonl"),
    );
    if (options.model !== undefined) {
      this.provider = null;
      this.agent = new Agent<AgentSdkContext>({
        name: "Chatty",
        instructions: AGENT_INSTRUCTIONS,
        model: options.model,
        modelSettings: { providerData: { thinking: { type: "disabled" } } },
        tools: buildAgentTools(),
      });
      this.runner = new Runner({
        tracingDisabled: false,
        traceIncludeSensitiveData: false,
      });
      return;
    }
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new RunFailure("llm_not_configured");
    this.provider = new OpenAIProvider({
      apiKey,
      baseURL:
        options.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
      useResponses: false,
    });
    this.agent = new Agent<AgentSdkContext>({
      name: "Chatty",
      instructions: AGENT_INSTRUCTIONS,
      model: modelId,
      modelSettings: { providerData: { thinking: { type: "disabled" } } },
      tools: buildAgentTools(),
    });
    this.runner = new Runner({
      modelProvider: this.provider,
      tracingDisabled: false,
      traceIncludeSensitiveData: false,
    });
  }

  private readonly modelId: string;

  async close(): Promise<void> {
    await this.provider?.close();
  }

  async run(
    input: RunRequest & { customer_id: string; request_id: string },
  ): Promise<RunResponse> {
    const sessionId =
      input.session_id ?? `session_${randomUUID().replaceAll("-", "")}`;
    if (input.session_id !== undefined && input.session_id !== null) {
      this.requireSession(sessionId, input.customer_id);
    }
    const traceId = `trace_${randomUUID().replaceAll("-", "")}`;
    const context = new AgentContext({
      customerId: input.customer_id,
      sessionId,
      message: input.message,
      traceId,
      requestId: input.request_id,
      commerce: this.runtime.commerce,
      artifactStore: this.runtime.artifacts,
      memoryStore: this.runtime.memory,
      supportStore: this.runtime.support,
      traceStore: this.runtime.traces,
    });
    context.memoryStore.bindSession(sessionId, input.customer_id);
    const sdkContext: AgentSdkContext = {
      harness: context,
      runtime: this.runtime,
      state: { knowledgeSearchResults: new Map<string, KnowledgeRecord>() },
    };
    const session = new SQLiteSession(
      sessionId,
      this.runtime.commerce.database,
    );
    this.tracing.register(traceId, this.runtime.traces);
    let result;
    try {
      try {
        const run = await withTrace(
          "Chatty Agent Run",
          async () =>
            this.runner.run(this.agent, input.message, {
              context: sdkContext,
              session,
            }),
          {
            traceId,
            groupId: sessionId,
            metadata: { model_id: this.modelId },
          },
        );
        result = completeAgentRun(context, {
          finalOutput: run.finalOutput,
          interrupted: run.interruptions.length > 0,
          attemptedToolNames: run.newItems
            .filter(
              (item): item is RunToolCallItem =>
                item instanceof RunToolCallItem,
            )
            .map((item) => item.toolName ?? ""),
          knowledgeSearchResults: sdkContext.state.knowledgeSearchResults,
        });
      } catch (error) {
        if (
          error instanceof ModelBehaviorError ||
          (error instanceof ToolCallError &&
            error.error instanceof ModelBehaviorError) ||
          (error instanceof Error &&
            error.constructor.name === "InvalidAgentOutputError")
        ) {
          context.priorActions.push("model_tool_call:rejected");
          result = forceHandoff(context, {
            reason: "Harness 拒绝无效操作",
            details: "Model 请求了无效或不可用的 Tool",
            knowledgeSearchResults: sdkContext.state.knowledgeSearchResults,
          });
        } else if (error instanceof MaxTurnsExceededError) {
          context.priorActions.push("agent_loop:max_turns");
          result = forceHandoff(context, {
            reason: "Harness 安全恢复已耗尽",
            details: "Agent 在受限 turns 内未完成处理",
            knowledgeSearchResults: sdkContext.state.knowledgeSearchResults,
          });
        } else {
          throw error;
        }
      }
      persistAgentRun(context, result);
      context.traceStore.complete(traceId);
    } catch (error) {
      if (error instanceof HandoffIdempotencyConflictError) {
        persistAgentFailure(
          this.runtime.traces,
          traceId,
          "handoff_idempotency_conflict",
        );
        throw new RunFailure("handoff_idempotency_conflict", traceId);
      }
      if (error instanceof HandoffPersistenceError) {
        persistAgentFailure(
          this.runtime.traces,
          traceId,
          "handoff_persistence_failed",
        );
        throw new RunFailure("handoff_persistence_failed", traceId);
      }
      persistAgentFailure(this.runtime.traces, traceId, "llm_provider_failed");
      throw new RunFailure(
        "llm_provider_failed",
        traceId,
        error instanceof Error ? error.constructor.name : typeof error,
        error,
      );
    } finally {
      this.tracing.discard(traceId);
    }

    const needsHuman = result.support_request_id !== null;
    return RunResponseSchema.parse({
      ...result,
      customer_id: input.customer_id,
      session_id: sessionId,
      trace_id: traceId,
      request_id: input.request_id,
      status: needsHuman
        ? "needs_human"
        : {
            verified: "completed",
            not_completed: "not_completed",
            not_applicable: "responded",
          }[result.business_outcome],
      needs_human: needsHuman,
    });
  }

  async sessionMessages(sessionId: string, customerId: string) {
    this.requireSession(sessionId, customerId);
    return new SQLiteSession(
      sessionId,
      this.runtime.commerce.database,
    ).getStoredItems();
  }

  private requireSession(sessionId: string, customerId: string): void {
    try {
      this.runtime.memory.requireSession(sessionId, customerId);
    } catch (error) {
      if (error instanceof SessionNotFoundError)
        throw new RunFailure("session_not_found");
      if (error instanceof SessionCustomerMismatchError) {
        throw new RunFailure("session_customer_mismatch");
      }
      throw error;
    }
  }
}
