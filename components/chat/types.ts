import type { Product, RunUsage } from "@/lib/api-client";

export type ChatEntry =
  | { kind: "user"; text: string }
  | { kind: "understood"; text: string }
  | { kind: "answer"; text: string }
  | { kind: "question"; text: string }
  | { kind: "run"; trace: string[]; latencyMs: number; usage: RunUsage }
  | { kind: "products"; products: Product[] }
  | { kind: "error"; code: string };
