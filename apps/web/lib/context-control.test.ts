import assert from "node:assert/strict";
import { test } from "node:test";
import { createControlPlaneRepository, openDatabase } from "@rental/db";
import type { MemorySnapshot } from "@rental/shared";
import { prepareTurnContext } from "./context-control";

/** Builds a snapshot large enough to force deterministic compaction. */
function largeSnapshot(): MemorySnapshot {
  return {
    customerId: "customer-1",
    conversationId: "conversation-1",
    recentMessages: Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `message-${index}-${"x".repeat(40)}`,
    })),
    customerMemory: { summary: "transaction summary" },
  };
}

/** Returns one deterministic checkpoint summary for compaction tests. */
async function checkpointSummary() {
  return {
    currentGoal: "finish rental",
    confirmedFacts: ["size L"],
    decisions: [],
    preferences: [],
    workflowState: "answering",
    unresolved: ["delivery date"],
    references: ["trace-2"],
  };
}

test("compaction persists the included trace boundary and actual projected token count", async () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  const snapshot = largeSnapshot();
  const memories = [
    {
      id: "memory-1",
      customerId: "customer-1",
      conversationId: "conversation-1",
      sourceTraceId: "trace-1",
      category: "measurement",
      key: "suit_size",
      value: "L",
      confidence: 1,
      sensitivity: "normal",
      evidenceKind: "explicit" as const,
      status: "promoted" as const,
      usageCount: 1,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    },
  ];
  const result = await prepareTurnContext({
    control,
    snapshot,
    checkpoint: undefined,
    traceIds: ["trace-1", "trace-2", "trace-3", "trace-4"],
    conversationId: "conversation-1",
    checkpointId: "checkpoint-1",
    workflowState: "answering",
    tokenLimit: 1,
    memories,
    generateCheckpoint: checkpointSummary,
  });

  assert.equal(result.checkpoint?.throughTraceId, "trace-1");
  assert.equal(
    result.checkpoint?.tokenAfter,
    Math.ceil(JSON.stringify(result.snapshot).length / 2),
  );
  assert.deepEqual(
    result.snapshot.recentMessages.map((message) =>
      (message as { content: string }).content.slice(0, 9),
    ),
    [
      "message-2",
      "message-3",
      "message-4",
      "message-5",
      "message-6",
      "message-7",
    ],
  );
  assert.deepEqual(
    (result.snapshot.customerMemory as { longTerm: unknown[] }).longTerm,
    [{ id: "memory-1", category: "measurement", key: "suit_size", value: "L" }],
  );
  assert.deepEqual(result.events, [
    {
      type: "compacted",
      payload: {
        checkpointId: "checkpoint-1",
        tokenBefore: result.tokenBefore,
        tokenAfter: result.checkpoint?.tokenAfter,
      },
    },
    {
      type: "context_built",
      payload: {
        estimatedTokens: result.tokenBefore,
        compactTriggered: true,
        checkpointVersion: result.checkpoint?.version,
        memoryIds: ["memory-1"],
      },
    },
  ]);
});

test("context preparation skips checkpoint work below the budget", async () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  const result = await prepareTurnContext({
    control,
    snapshot: largeSnapshot(),
    checkpoint: undefined,
    traceIds: [],
    conversationId: "conversation-1",
    checkpointId: "checkpoint-unused",
    workflowState: "answering",
    memories: [],
    tokenLimit: 100_000,
    generateCheckpoint: async () => {
      throw new Error("checkpoint generator must not run");
    },
  });

  assert.equal(result.triggered, false);
  assert.equal(result.checkpoint, undefined);
  assert.equal(result.snapshot.recentMessages.length, 6);
  assert.deepEqual(result.events, [
    {
      type: "context_built",
      payload: {
        estimatedTokens: result.tokenBefore,
        compactTriggered: false,
        checkpointVersion: 0,
        memoryIds: [],
      },
    },
  ]);
});

test("projected context preserves verified body profiles for the agent", async () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  const result = await prepareTurnContext({
    control,
    snapshot: {
      customerId: "customer-1",
      conversationId: "conversation-1",
      recentMessages: [],
      customerMemory: {
        bodyProfiles: [{ profileId: "default", heightCm: 178, weightKg: 70 }],
      },
    },
    traceIds: [],
    conversationId: "conversation-1",
    checkpointId: "checkpoint-1",
    workflowState: "answering",
    memories: [],
  });

  assert.deepEqual(result.snapshot.customerMemory, {
    summary: {
      bodyProfiles: [{ profileId: "default", heightCm: 178, weightKg: 70 }],
    },
    checkpoint: null,
    longTerm: [],
  });
});

test("compaction preserves the previous checkpoint when generation or save fails", async () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  const previous = control.saveCheckpoint({
    id: "checkpoint-old",
    conversationId: "conversation-1",
    throughTraceId: "trace-1",
    summary: { currentGoal: "old goal" },
    tokenBefore: 100,
    tokenAfter: 20,
    model: "deepseek-v4-pro",
  });

  const result = await prepareTurnContext({
    control,
    snapshot: largeSnapshot(),
    checkpoint: previous,
    traceIds: ["trace-1", "trace-2", "trace-3", "trace-4"],
    conversationId: "conversation-1",
    checkpointId: "checkpoint-new",
    workflowState: "answering",
    memories: [],
    tokenLimit: 1,
    generateCheckpoint: async () => {
      throw new Error("provider unavailable");
    },
  });

  assert.equal(result.failureKind, "generation_or_save_failed");
  assert.deepEqual(control.latestCheckpoint("conversation-1"), previous);
  assert.deepEqual(
    (result.snapshot.customerMemory as { checkpoint: unknown }).checkpoint,
    previous.summary,
  );
  assert.deepEqual(result.events, [
    {
      type: "compaction_failed",
      payload: {
        failureKind: "generation_or_save_failed",
        checkpointVersion: previous.version,
      },
    },
    {
      type: "context_built",
      payload: {
        estimatedTokens: result.tokenBefore,
        compactTriggered: true,
        checkpointVersion: previous.version,
        memoryIds: [],
      },
    },
  ]);
});

test("compaction preserves the previous checkpoint when persistence rejects the replacement", async () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  const previous = control.saveCheckpoint({
    id: "checkpoint-old",
    conversationId: "conversation-1",
    throughTraceId: "trace-1",
    summary: { currentGoal: "old goal" },
    tokenBefore: 100,
    tokenAfter: 20,
    model: "deepseek-v4-pro",
  });
  const rejectingControl = {
    ...control,
    /** Simulates an atomic checkpoint persistence failure. */
    saveCheckpoint() {
      throw new Error("disk unavailable");
    },
  };

  const result = await prepareTurnContext({
    control: rejectingControl,
    snapshot: largeSnapshot(),
    checkpoint: previous,
    traceIds: ["trace-1", "trace-2", "trace-3", "trace-4"],
    conversationId: "conversation-1",
    checkpointId: "checkpoint-new",
    workflowState: "answering",
    memories: [],
    tokenLimit: 1,
    generateCheckpoint: checkpointSummary,
  });

  assert.equal(result.failureKind, "generation_or_save_failed");
  assert.deepEqual(control.latestCheckpoint("conversation-1"), previous);
});

test("compaction refuses to invent a replay boundary before any trace exists", async () => {
  const control = createControlPlaneRepository(openDatabase(":memory:"));
  const result = await prepareTurnContext({
    control,
    snapshot: largeSnapshot(),
    checkpoint: undefined,
    traceIds: [],
    conversationId: "conversation-1",
    checkpointId: "checkpoint-1",
    workflowState: "answering",
    memories: [],
    tokenLimit: 1,
    generateCheckpoint: checkpointSummary,
  });

  assert.equal(result.failureKind, "boundary_unavailable");
  assert.equal(control.latestCheckpoint("conversation-1"), undefined);
  assert.equal(result.snapshot.recentMessages.length, 6);
  assert.deepEqual(result.events, [
    {
      type: "compaction_failed",
      payload: {
        failureKind: "boundary_unavailable",
        checkpointVersion: 0,
      },
    },
    {
      type: "context_built",
      payload: {
        estimatedTokens: result.tokenBefore,
        compactTriggered: true,
        checkpointVersion: 0,
        memoryIds: [],
      },
    },
  ]);
});
