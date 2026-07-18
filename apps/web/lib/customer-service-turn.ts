import type {
  KnowledgeRepository,
  MemoryRepository,
  SessionRepository,
  TraceRepository,
  ControlPlaneRepository,
  CommerceRepository,
  DurableTaskRepository,
  DurableTask,
} from "@rental/db";
import {
  createDefaultToolRegistry,
  runCustomerServiceHarnessStep,
  type CommerceToolBackend,
} from "@rental/agent-core";
import type {
  HarnessTrace,
  JsonValue,
  LegacyChatInput,
  PlaygroundResponse,
} from "@rental/shared";
import { getRepos, newId } from "./db";
import { createPlaygroundLlmRuntime } from "./llm";
import { HarnessRunController } from "./harness-run-controller";
import {
  prepareTurnContext,
  type CheckpointGenerator,
} from "./context-control";

export type CustomerServiceTurnRepos = {
  sessions: SessionRepository;
  traces: TraceRepository;
  memory: MemoryRepository;
  knowledge: KnowledgeRepository;
  control: ControlPlaneRepository;
  commerce?: CommerceRepository;
  tasks?: DurableTaskRepository;
};

export type CustomerServiceTurnResponse = PlaygroundResponse;

type CustomerServiceTurnLlmRuntime = ReturnType<
  typeof createPlaygroundLlmRuntime
>;
type CustomerServiceTurnOptions = {
  repos?: CustomerServiceTurnRepos;
  idGenerator?: (prefix: string) => string;
  now?: () => string;
  llmRuntimeFactory?: () => CustomerServiceTurnLlmRuntime;
  idempotencyKey?: string;
  queuedTurnDispatcher?: (input: LegacyChatInput) => Promise<void>;
  recoverRunId?: string;
  resumeHandoffRunId?: string;
  cancellationPollMs?: number;
  signal?: AbortSignal;
  checkpointGenerator?: CheckpointGenerator;
  compactionTokenLimit?: number;
  handoffResolution?: string;
};

export class CustomerServiceProviderError extends Error {
  constructor(cause: unknown) {
    super("DeepSeek Agents SDK run failed", { cause });
    this.name = "CustomerServiceProviderError";
  }
}

class CustomerServiceCancelledError extends Error {
  constructor() {
    super("Customer Service Turn cancelled");
    this.name = "CustomerServiceCancelledError";
  }
}

/**
 * Runs one seller-side Customer Service Turn from parsed input. This module is
 * the product use-case seam: it owns session creation, event shaping, harness
 * execution, trace persistence, and continuity memory writes; HTTP routes stay
 * as adapters.
 */
export async function runCustomerServiceTurn(
  input: LegacyChatInput,
  options: CustomerServiceTurnOptions = {},
): Promise<CustomerServiceTurnResponse> {
  const repos = options.repos ?? getRepos();
  const id = options.idGenerator ?? newId;
  const now = options.now ?? (() => new Date().toISOString());
  const conversationId =
    input.conversationId ??
    `${input.customerId}:${input.productId ?? "general"}`;
  const taskWaitFor = options.handoffResolution ? "human" : "customer";
  const waitingTask = options.handoffResolution
    ? repos.tasks?.findWaitingHumanByRunId(
        conversationId,
        options.resumeHandoffRunId ?? "",
      )
    : repos.tasks?.findWaiting(conversationId, "customer");
  if (options.handoffResolution && !waitingTask) {
    throw new Error(
      `waiting handoff task not found for run: ${options.resumeHandoffRunId ?? "unknown"}`,
    );
  }
  let durableTask: DurableTask | undefined = waitingTask
    ? repos.tasks?.resume(waitingTask.id, taskWaitFor)
    : undefined;

  let session = repos.sessions.findByConversation(conversationId);
  if (!session) {
    session = repos.sessions.create({
      id: id("sess"),
      customerId: input.customerId,
      conversationId,
      productId: input.productId,
    });
  }

  const traceId = id("tr");
  const event = {
    eventId: id("evt"),
    type: options.handoffResolution
      ? ("human_agent_replied" as const)
      : ("user_message" as const),
    customerId: input.customerId,
    conversationId,
    productId: input.productId,
    source: options.handoffResolution
      ? ("human" as const)
      : ("customer" as const),
    payload: createTurnPayload(input),
    occurredAt: now(),
    traceId,
  };
  const runId = options.recoverRunId ?? options.resumeHandoffRunId ?? id("run");
  const runController = new HarnessRunController(repos.control);
  const started = options.resumeHandoffRunId
    ? { ...runController.resumeHandoff(runId), replayed: false }
    : options.recoverRunId
      ? { ...runController.recover(runId), replayed: false }
      : runController.start({
          runId,
          sessionId: session.id,
          conversationId,
          idempotencyKey: options.idempotencyKey ?? event.eventId,
          event: event as unknown as JsonValue,
        });
  if (started.replayed) {
    if (started.run.status === "completed" && started.run.result) {
      return started.run.result as unknown as CustomerServiceTurnResponse;
    }
    throw new Error(`workflow run already in progress: ${started.run.id}`);
  }
  /** Bridges an owning background-job cancellation into the durable workflow state. */
  const externalCancellation = () =>
    repos.control.requestRunCancellation(runId, "background_job_cancelled");
  options.signal?.addEventListener("abort", externalCancellation, {
    once: true,
  });
  const heartbeat = setInterval(() => runController.heartbeat(runId), 20_000);
  heartbeat.unref();
  const cancellationPoll = setInterval(
    () => runController.observeCancellation(runId),
    options.cancellationPollMs ?? 100,
  );
  cancellationPoll.unref();
  try {
    const memoryEligible =
      (repos.commerce?.countConfirmedOrders(input.customerId) ?? 0) >= 2;
    const rawSnapshot = repos.memory.snapshot({
      customerId: input.customerId,
      conversationId,
      productId: input.productId,
    });
    const snapshot = memoryEligible
      ? rawSnapshot
      : {
          ...rawSnapshot,
          customerMemory: undefined,
          bodyProfiles: [],
          globalSummary: "",
        };
    const promotedMemories = memoryEligible
      ? repos.control.listMemoryCandidates(input.customerId, "promoted")
      : [];
    const checkpointBefore = repos.control.latestCheckpoint(conversationId);
    const priorTraces = repos.traces.queryBySession(session.id);
    if (promotedMemories.length) {
      repos.control.markMemoryUsed(promotedMemories.map((memory) => memory.id));
    }
    const preparedContext = await prepareTurnContext({
      control: repos.control,
      snapshot,
      checkpoint: checkpointBefore,
      traceIds: priorTraces.map((trace) => trace.id),
      conversationId,
      checkpointId: id("cp"),
      workflowState: session.currentStep,
      memories: promotedMemories,
      generateCheckpoint: options.checkpointGenerator,
      tokenLimit: options.compactionTokenLimit,
    });
    const projectedSnapshot = preparedContext.snapshot;
    for (const event of preparedContext.events) {
      runController.event(runId, event.type, event.payload);
    }
    let llm: CustomerServiceTurnLlmRuntime;
    try {
      llm = options.llmRuntimeFactory
        ? options.llmRuntimeFactory()
        : createPlaygroundLlmRuntime();
    } catch (error) {
      throwIfTurnCancelled(started.signal, repos.control, runId);
      repos.traces.append({
        id: traceId,
        sessionId: session.id,
        eventType: "evaluation_failed",
        input: {
          question: input.question,
          ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
        },
        output: { failureKind: "configuration_error", message: String(error) },
        toolCalls: [],
        references: [],
      });
      repos.sessions.update(session.id, {
        status: "failed",
        currentStep: "configuration_error",
      });
      runController.transition(runId, "failed", {
        failureKind: "configuration_error",
      });
      throw error;
    }

    const workflowCapabilities = repos.tasks
      ? {
          createHandoff: (
            args: Record<string, JsonValue>,
            capabilityOptions?: { signal?: AbortSignal },
          ): JsonValue => {
            capabilityOptions?.signal?.throwIfAborted();
            const context: JsonValue = {
              customerId: input.customerId,
              productId: input.productId ?? null,
              question: input.question,
              reason: args.reason ?? null,
              priorActions: args.context ?? null,
              runId,
            };
            durableTask ??= repos.tasks!.create({
              id: id("task"),
              conversationId,
              subject: "等待人工处理",
              description: String(args.reason ?? "需要人工处理"),
              context,
            });
            if (durableTask.status !== "waiting") {
              durableTask = repos.tasks!.wait(durableTask.id, "human", {
                context,
              });
            }
            return {
              ok: true,
              handoffId: durableTask.id,
              taskId: durableTask.id,
              status: durableTask.status,
              conversationId,
            };
          },
          scheduleFollowup: (
            args: Record<string, JsonValue>,
            capabilityOptions?: { signal?: AbortSignal },
          ): JsonValue => {
            capabilityOptions?.signal?.throwIfAborted();
            const context: JsonValue = {
              customerId: input.customerId,
              productId: input.productId ?? null,
              question: input.question,
              reason: args.reason ?? null,
              runId,
            };
            durableTask ??= repos.tasks!.create({
              id: id("task"),
              conversationId,
              subject: "定时跟进",
              description: String(args.reason ?? "到时跟进客户"),
              context,
            });
            if (durableTask.status !== "waiting") {
              durableTask = repos.tasks!.wait(durableTask.id, "time", {
                dueAt: typeof args.dueAt === "string" ? args.dueAt : now(),
                context,
              });
            }
            repos.control.enqueueJob({
              id: id("job"),
              type: "scheduled_followup",
              conversationId,
              customerId: input.customerId,
              payload: { ...args, durableTaskId: durableTask.id },
              dueAt: durableTask.dueAt ?? now(),
              idempotencyKey: `durable-task:${durableTask.id}:delivery`,
            });
            return {
              ok: true,
              followupId: durableTask.id,
              taskId: durableTask.id,
              dueAt: durableTask.dueAt ?? null,
              status: durableTask.status,
            };
          },
        }
      : undefined;
    let harness;
    try {
      harness = await runCustomerServiceHarnessStep({
        event,
        memory: projectedSnapshot,
        registry: createDefaultToolRegistry(
          repos.knowledge,
          workflowCapabilities,
          repos.commerce
            ? createCommerceToolBackend(repos.commerce, id)
            : undefined,
        ),
        sessionStatus: session.status,
        sdkRunner: llm.sdkRunner,
        runId,
        signal: started.signal,
        emitEvent: (type, payload = {}) =>
          runController.event(runId, type, payload),
      });
      if (
        ["handoff", "schedule_followup"].includes(
          harness.trace.action.action,
        ) &&
        !durableTask
      ) {
        throw new Error(
          `side-effect action has no durable task receipt: ${harness.trace.action.action}`,
        );
      }
    } catch (error) {
      throwIfTurnCancelled(started.signal, repos.control, runId);
      repos.traces.append({
        id: traceId,
        sessionId: session.id,
        eventType: "evaluation_failed",
        input: {
          question: input.question,
          ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
        },
        output: {
          failureKind: "provider_or_output_validation",
          message: String(error),
        },
        toolCalls: [],
        references: [],
      });
      repos.sessions.update(session.id, {
        status: "failed",
        currentStep: "provider_error",
      });
      runController.transition(runId, "failed", {
        failureKind: "provider_or_output_validation",
      });
      throw new CustomerServiceProviderError(error);
    }
    const result = harness.step;
    if (!result.reply?.trim()) {
      throw new Error("customer-service turn produced an empty reply");
    }
    const harnessTrace = {
      ...harness.trace,
      llm: llm.summary(),
    } as unknown as HarnessTrace;

    repos.traces.append({
      id: traceId,
      sessionId: session.id,
      eventType: "agent_reply_sent",
      intent: harness.trace.task.kind,
      action: harness.trace.action.action,
      input: {
        question: input.question,
        ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
        harnessContext: harness.trace.context.fragments as unknown as JsonValue,
      },
      output:
        result.reply || result.memoryPatch
          ? {
              ...(result.reply ? { reply: result.reply } : {}),
              ...(result.memoryPatch !== undefined
                ? { memoryPatch: result.memoryPatch }
                : {}),
              harnessTrace: harnessTrace as unknown as JsonValue,
            }
          : undefined,
      toolCalls: result.toolCalls,
      references: harness.trace.context.fragments as unknown as JsonValue[],
    });
    repos.sessions.update(session.id, {
      status: result.nextStatus,
      currentStep: result.terminality,
      productId: input.productId,
    });
    if (repos.tasks) {
      if (
        result.terminality === "reply_and_wait" &&
        harness.trace.action.action === "ask_missing_info"
      ) {
        durableTask ??= repos.tasks.create({
          id: id("task"),
          conversationId,
          subject: "等待客户补充信息",
          description: result.reply ?? "",
          context: {
            customerId: input.customerId,
            productId: input.productId ?? null,
            originalQuestion: input.question,
            missingFields: harness.trace.action.toolArgs?.missingFields ?? [],
          },
        });
        durableTask = repos.tasks.wait(durableTask.id, "customer", {
          context: durableTask.context,
        });
      } else if (durableTask?.status === "in_progress") {
        const receipt = findSuccessfulBusinessToolReceipt(
          harness.trace.toolCalls,
          harness.trace.toolResults,
          traceId,
        );
        if (options.handoffResolution) {
          durableTask = repos.tasks.complete(durableTask.id, {
            kind: "human_resolution",
            resolutionId: `resolution:${event.eventId}`,
            resolution: options.handoffResolution,
            traceId,
          });
        } else if (receipt) {
          durableTask = repos.tasks.complete(durableTask.id, receipt);
        } else {
          durableTask = repos.tasks.wait(durableTask.id, "customer", {
            context: durableTask.context,
          });
        }
      }
    }
    if (result.nextStatus === "waiting_for_human") {
      runController.transition(runId, "waiting_for_handoff");
      runController.event(runId, "handoff_requested", { traceId });
    }
    appendTurnContinuity(repos.memory, {
      customerId: input.customerId,
      productId: input.productId ?? "general",
      conversationId,
      question: input.question,
      reply: result.reply,
    });
    if (memoryEligible) {
      repos.control.scheduleMemoryExtraction({
        id: id("job"),
        conversationId,
        customerId: input.customerId,
        payload: {
          sessionId: session.id,
          productId: input.productId ?? "general",
        },
        now: now(),
        coolingMs: 24 * 60 * 60 * 1000,
      });
    }

    const response: CustomerServiceTurnResponse = {
      reply: result.reply ?? "",
      traceId,
      sessionId: session.id,
      status: result.nextStatus,
      terminality: result.terminality,
      harnessTrace,
      runId,
      ...(durableTask
        ? { taskId: durableTask.id, taskStatus: durableTask.status }
        : {}),
    };
    if (result.nextStatus !== "waiting_for_human") {
      if (!runController.saveResult(runId, response as unknown as JsonValue)) {
        throw new Error(`workflow result could not be persisted: ${runId}`);
      }
      runController.transition(runId, "completed");
      runController.event(runId, "completed", {
        traceId,
        terminality: result.terminality,
      });
    }

    await drainQueuedTurns(conversationId, repos, options);

    clearInterval(heartbeat);
    clearInterval(cancellationPoll);
    options.signal?.removeEventListener("abort", externalCancellation);
    return response;
  } catch (error) {
    clearInterval(heartbeat);
    clearInterval(cancellationPoll);
    options.signal?.removeEventListener("abort", externalCancellation);
    const current = repos.control.getRun(runId);
    if (current && ["queued", "running", "paused"].includes(current.status)) {
      repos.sessions.update(session.id, {
        status: "failed",
        currentStep: "control_plane_error",
      });
      runController.transition(runId, "failed", {
        failureKind: "control_plane_error",
      });
    }
    if (current?.status === "cancelled") {
      await drainQueuedTurns(conversationId, repos, options);
      throw new CustomerServiceCancelledError();
    }
    throw error;
  }
}

/** Returns evidence only for a successful business-system side effect/read. */
function findSuccessfulBusinessToolReceipt(
  calls: Array<{ toolName: string }>,
  results: JsonValue[],
  traceId: string,
) {
  const businessTools = new Set([
    "search_knowledge",
    "check_availability",
    "create_order",
    "confirm_order",
    "cancel_order",
  ]);
  for (
    let index = Math.min(calls.length, results.length) - 1;
    index >= 0;
    index--
  ) {
    const result = results[index];
    const failed =
      result !== null &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      typeof result.error === "string";
    const toolName = calls[index]!.toolName;
    if (businessTools.has(toolName) && !failed) {
      return {
        kind: "tool_receipt" as const,
        toolName,
        receiptId: `${traceId}:${index}`,
        traceId,
      };
    }
  }
  return undefined;
}

function createCommerceToolBackend(
  commerce: CommerceRepository,
  id: (prefix: string) => string,
): CommerceToolBackend {
  const scopedOrder = (input: Record<string, JsonValue>) => {
    const orderId = String(input.orderId ?? "");
    const order = commerce.getOrder(orderId);
    if (
      !order ||
      order.customerId !== String(input.customerId ?? "") ||
      order.conversationId !== String(input.conversationId ?? "")
    ) {
      throw new Error(`order not found in trusted customer scope: ${orderId}`);
    }
    return order;
  };
  return {
    checkAvailability: (input) =>
      commerce.checkAvailability(input) as unknown as JsonValue,
    createOrder: (input) =>
      commerce.createOrder({
        id: id("order"),
        idempotencyKey: `order:${String(input.requestId ?? "")}`,
        customerId: String(input.customerId ?? ""),
        conversationId: String(input.conversationId ?? ""),
        productId: String(input.productId ?? ""),
        size: String(input.size ?? ""),
        fulfillmentMode:
          input.fulfillmentMode === "buyout" ? "buyout" : "rental",
        quantity: Number(input.quantity ?? 1),
        ...(typeof input.startDate === "string"
          ? { startDate: input.startDate }
          : {}),
        ...(typeof input.endDate === "string"
          ? { endDate: input.endDate }
          : {}),
      }) as unknown as JsonValue,
    confirmOrder: (input) => {
      const order = scopedOrder(input);
      return commerce.confirmOrder(order.id) as unknown as JsonValue;
    },
    cancelOrder: (input) => {
      const order = scopedOrder(input);
      return commerce.cancelOrder(order.id) as unknown as JsonValue;
    },
  };
}

/** Resumes one durable human handoff through the Customer Service Turn execution seam. */
export async function resumeCustomerServiceHandoff(
  runId: string,
  options: CustomerServiceTurnOptions = {},
): Promise<CustomerServiceTurnResponse> {
  const repos = options.repos ?? getRepos();
  const scheduled = repos.control
    .listRunEvents(runId)
    .find((event) => event.type === "scheduled");
  const input = scheduled ? inputFromQueuedEvent(scheduled.payload) : undefined;
  if (!input)
    throw new Error(`workflow handoff has no resumable input: ${runId}`);
  return runCustomerServiceTurn(
    { ...input, question: options.handoffResolution ?? input.question },
    { ...options, repos, resumeHandoffRunId: runId },
  );
}

/** Normalizes any observed durable or in-process cancellation into the public turn error. */
function throwIfTurnCancelled(
  signal: AbortSignal,
  control: ControlPlaneRepository,
  runId: string,
): void {
  if (signal.aborted || control.getRun(runId)?.cancelRequestedAt) {
    throw new CustomerServiceCancelledError();
  }
}

/** Dispatches durable FIFO inputs after any terminal workflow outcome. */
async function drainQueuedTurns(
  conversationId: string,
  repos: CustomerServiceTurnRepos,
  options: CustomerServiceTurnOptions,
): Promise<void> {
  let queuedEntry = repos.control.claimConversationEvent(conversationId);
  while (queuedEntry) {
    const queuedInput = inputFromQueuedEvent(queuedEntry.event);
    if (queuedInput) {
      try {
        if (options.queuedTurnDispatcher) {
          await options.queuedTurnDispatcher(queuedInput);
        } else {
          await runCustomerServiceTurn(queuedInput, {
            ...options,
            idempotencyKey: queuedEventId(queuedEntry.event),
          });
        }
        repos.control.completeConversationEvent(queuedEntry.id);
      } catch (error) {
        repos.control.releaseConversationEvent(queuedEntry.id);
        throw error;
      }
    } else {
      repos.control.failConversationEvent(queuedEntry.id);
      throw new Error(
        `queued conversation event has an invalid payload: ${queuedEntry.id}`,
      );
    }
    if (!options.queuedTurnDispatcher) break;
    queuedEntry = repos.control.claimConversationEvent(conversationId);
  }
}

/** Recovers expired Customer Service Turns from durable scheduled events after process startup. */
export async function recoverCustomerServiceTurns(
  options: CustomerServiceTurnOptions & { now?: () => string } = {},
): Promise<string[]> {
  const repos = options.repos ?? getRepos();
  const now = options.now ?? (() => new Date().toISOString());
  const recovered: string[] = [];
  for (const run of repos.control.listRecoverableRuns(now())) {
    const scheduled = repos.control
      .listRunEvents(run.id)
      .find((event) => event.type === "scheduled");
    const input = scheduled
      ? inputFromQueuedEvent(scheduled.payload)
      : undefined;
    if (!input) {
      repos.control.transitionRun(run.id, "failed", "invalid_recovery_payload");
      repos.control.appendRunEvent(run.id, "recovery_failed", {
        failureKind: "invalid_recovery_payload",
      });
      continue;
    }
    await runCustomerServiceTurn(input, {
      ...options,
      repos,
      recoverRunId: run.id,
    });
    recovered.push(run.id);
  }
  return recovered;
}

/** Rebuilds a Customer Service Turn input from one durable queued harness event. */
function inputFromQueuedEvent(event: JsonValue): LegacyChatInput | undefined {
  if (event === null || typeof event !== "object" || Array.isArray(event))
    return undefined;
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return undefined;
  if (
    typeof event.customerId !== "string" ||
    typeof payload.question !== "string"
  )
    return undefined;
  return {
    customerId: event.customerId,
    conversationId:
      typeof event.conversationId === "string"
        ? event.conversationId
        : undefined,
    productId:
      typeof event.productId === "string" ? event.productId : undefined,
    question: payload.question,
    imageUrl:
      typeof payload.imageUrl === "string" ? payload.imageUrl : undefined,
  };
}

/** Reads the original request identity retained inside a durable queued event. */
function queuedEventId(event: JsonValue): string | undefined {
  if (event === null || typeof event !== "object" || Array.isArray(event))
    return undefined;
  return typeof event.eventId === "string" ? event.eventId : undefined;
}

/** Builds the event payload consumed by the harness from parsed input. */
function createTurnPayload(input: LegacyChatInput): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = { question: input.question };
  if (input.imageUrl) payload.imageUrl = input.imageUrl;
  return payload;
}

/** Persists the minimal recent-message continuity needed by the next turn. */
function appendTurnContinuity(
  memory: MemoryRepository,
  input: {
    customerId: string;
    productId: string;
    conversationId: string;
    question: string;
    reply?: string;
  },
) {
  const turn: JsonValue[] = [{ role: "user", content: input.question }];
  if (input.reply) turn.push({ role: "assistant", content: input.reply });
  memory.appendRecentMessages(
    {
      customerId: input.customerId,
      productId: input.productId,
      conversationId: input.conversationId,
    },
    turn,
  );
}
