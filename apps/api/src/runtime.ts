import type {
  Artifact,
  ArtifactApproval,
  CustomerMemory,
  Order,
  SupportRequest,
  TraceSpan,
} from "@chatty/contracts";
import { ArtifactStore } from "./artifacts.js";
import { CommerceStore, type OrderStatus } from "./commerce.js";
import { KnowledgeStore } from "./knowledge.js";
import {
  MemoryStore,
  SupportRequestStore,
  TraceStore,
  type TraceSummary,
} from "./stores.js";

export type NativeRuntimePort = {
  artifacts: {
    list(ownerId: string, sessionId?: string): Artifact[];
    approve(
      artifactId: string,
      actorId: string,
      ownerId: string,
    ): ArtifactApproval;
  };
  commerce: {
    listOrders(): Order[];
    getOrder(orderId: string): Order;
    statusCounts(): Record<OrderStatus, number>;
  };
  knowledge: {
    importJsonl(sourcePath: string): number;
    search(
      query: string,
      limit: number,
    ): import("@chatty/contracts").KnowledgeSearchResult;
  };
  memory: {
    search(customerId: string, query: string, limit: number): CustomerMemory[];
  };
  support: {
    listAll(): SupportRequest[];
    get(requestId: string): SupportRequest | null;
  };
  traces: {
    listRecent(limit?: number): TraceSummary[];
    get(traceId: string): TraceSummary | null;
    spans(traceId: string): TraceSpan[];
    spanTypes(traceId: string): string[];
  };
  close(): void;
};

export class NativeRuntime implements NativeRuntimePort {
  readonly artifacts: ArtifactStore;
  readonly commerce: CommerceStore;
  readonly knowledge: KnowledgeStore;
  readonly memory: MemoryStore;
  readonly support: SupportRequestStore;
  readonly traces: TraceStore;

  constructor(readonly databasePath: string) {
    this.artifacts = new ArtifactStore(databasePath);
    this.commerce = new CommerceStore(databasePath);
    this.knowledge = new KnowledgeStore(this.commerce.database);
    this.memory = new MemoryStore(databasePath);
    this.support = new SupportRequestStore(databasePath);
    this.traces = new TraceStore(databasePath);
  }

  close(): void {
    this.traces.close();
    this.support.close();
    this.memory.close();
    this.artifacts.close();
    this.commerce.close();
  }
}
