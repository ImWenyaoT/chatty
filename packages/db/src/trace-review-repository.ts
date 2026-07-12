import type { JsonValue } from "@rental/shared";
import type { Db } from "./database.js";
import { nowIso } from "./database.js";

export type TraceReviewLabel = "pass" | "fail" | "flagged";

export interface TraceReview {
  traceId: string;
  label: TraceReviewLabel;
  reviewer: string;
  note: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NewTraceReview {
  traceId: string;
  label: TraceReviewLabel;
  reviewer: string;
  note?: string;
  tags?: string[];
}

export interface TraceReviewSummary {
  total: number;
  pass: number;
  fail: number;
  flagged: number;
  tags: Record<string, number>;
}

export interface TraceReviewRepository {
  upsert(input: NewTraceReview): TraceReview;
  listBySession(sessionId: string): TraceReview[];
  summarize(): TraceReviewSummary;
}

interface TraceReviewRow {
  trace_id: string;
  label: TraceReviewLabel;
  reviewer: string;
  note: string;
  tags_json: string;
  created_at: string;
  updated_at: string;
}

/** Creates the minimal human feedback repository for trace review metrics. */
export function createTraceReviewRepository(db: Db): TraceReviewRepository {
  const toReview = (row: TraceReviewRow): TraceReview => ({
    traceId: row.trace_id,
    label: row.label,
    reviewer: row.reviewer,
    note: row.note,
    tags: parseTags(row.tags_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  return {
    upsert(input) {
      const existing = db
        .prepare("SELECT * FROM agent_trace_reviews WHERE trace_id = ?")
        .get(input.traceId) as TraceReviewRow | undefined;
      const createdAt = existing?.created_at ?? nowIso();
      const updatedAt = nowIso();
      const tags = normalizeTags(input.tags ?? []);
      db.prepare(
        `INSERT INTO agent_trace_reviews (trace_id, label, reviewer, note, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trace_id) DO UPDATE SET
           label = excluded.label,
           reviewer = excluded.reviewer,
           note = excluded.note,
           tags_json = excluded.tags_json,
           updated_at = excluded.updated_at`,
      ).run(
        input.traceId,
        input.label,
        input.reviewer,
        input.note ?? "",
        JSON.stringify(tags),
        createdAt,
        updatedAt,
      );
      return {
        traceId: input.traceId,
        label: input.label,
        reviewer: input.reviewer,
        note: input.note ?? "",
        tags,
        createdAt,
        updatedAt,
      };
    },

    listBySession(sessionId) {
      const rows = db
        .prepare(
          `SELECT r.*
           FROM agent_trace_reviews r
           JOIN agent_traces t ON t.id = r.trace_id
           WHERE t.session_id = ?
           ORDER BY t.created_at ASC, r.updated_at ASC`,
        )
        .all(sessionId) as TraceReviewRow[];
      return rows.map(toReview);
    },

    summarize() {
      const rows = db
        .prepare("SELECT * FROM agent_trace_reviews ORDER BY updated_at ASC")
        .all() as TraceReviewRow[];
      return rows.reduce<TraceReviewSummary>(
        (summary, row) => {
          summary.total += 1;
          summary[row.label] += 1;
          for (const tag of parseTags(row.tags_json)) {
            summary.tags[tag] = (summary.tags[tag] ?? 0) + 1;
          }
          return summary;
        },
        { total: 0, pass: 0, fail: 0, flagged: 0, tags: {} },
      );
    },
  };
}

/** Parses persisted review tags defensively so a corrupt row cannot break dashboards. */
function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as JsonValue;
    if (!Array.isArray(parsed)) return [];
    return normalizeTags(
      parsed.filter((tag): tag is string => typeof tag === "string"),
    );
  } catch {
    return [];
  }
}

/** Normalizes feedback tags for stable metrics and deterministic tests. */
function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].sort();
}
