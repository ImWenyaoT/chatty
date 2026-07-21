import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ArtifactSchema,
  type Artifact,
  type ArtifactApproval,
  type ArtifactStatus,
  type ContentChannel,
  type IndustryNode,
  type IndustryRelation,
  type ResearchClaim,
} from "@chatty/contracts";
import { integer, type SqliteRow as Row, text } from "./sqlite-row.js";

type ResearchArtifact = Extract<Artifact, { kind: "research" }>;
type ContentArtifact = Extract<Artifact, { kind: "content" }>;

export type ArtifactReview = {
  id: string;
  artifact_id: string;
  passed: boolean;
  errors: string[];
  created_at: string;
};

export type DeliveryReceipt = {
  id: string;
  artifact_id: string;
  target: "sandbox";
  content_hash: string;
  created_at: string;
};

export class ArtifactNotFoundError extends Error {}
export class DeliveryNotFoundError extends Error {}

export class ArtifactStateError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class ArtifactStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          title TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
              DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL
              DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS artifacts_owner_session_created
          ON artifacts (owner_id, session_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS artifact_reviews (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL UNIQUE,
          passed INTEGER NOT NULL,
          errors_json TEXT NOT NULL,
          created_at TEXT NOT NULL
              DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
      );
      CREATE TABLE IF NOT EXISTS artifact_approvals (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL UNIQUE,
          actor_id TEXT NOT NULL,
          decision TEXT NOT NULL,
          created_at TEXT NOT NULL
              DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
      );
      CREATE TABLE IF NOT EXISTS artifact_deliveries (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL,
          target TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
              DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          UNIQUE (artifact_id, target),
          FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
      );
    `);
  }

  close(): void {
    this.database.close();
  }

  createResearch(input: {
    idempotency_key: string;
    owner_id: string;
    session_id: string;
    title: string;
    summary: string;
    claims: ResearchClaim[];
    nodes: IndustryNode[];
    relations: IndustryRelation[];
    unknowns: string[];
  }): ResearchArtifact {
    return this.create(
      {
        idempotency_key: input.idempotency_key,
        kind: "research",
        owner_id: input.owner_id,
        session_id: input.session_id,
        title: input.title,
        payload: {
          summary: input.summary,
          claims: input.claims,
          nodes: input.nodes,
          relations: input.relations,
          unknowns: input.unknowns,
        },
      },
      "research",
    );
  }

  createContent(input: {
    idempotency_key: string;
    owner_id: string;
    session_id: string;
    research_artifact_id: string;
    title: string;
    channels: ContentChannel[];
  }): ContentArtifact {
    const research = this.get(input.research_artifact_id);
    if (
      research.kind !== "research" ||
      !["review_pending", "approved", "exported"].includes(research.status)
    ) {
      throw new ArtifactStateError("research_artifact_not_reviewed");
    }
    if (
      research.owner_id !== input.owner_id ||
      research.session_id !== input.session_id
    ) {
      throw new ArtifactStateError("artifact_lineage_mismatch");
    }
    return this.create(
      {
        idempotency_key: input.idempotency_key,
        kind: "content",
        owner_id: input.owner_id,
        session_id: input.session_id,
        title: input.title,
        payload: {
          research_artifact_id: input.research_artifact_id,
          channels: input.channels,
        },
      },
      "content",
    );
  }

  get(artifactId: string): Artifact {
    const row = this.database
      .prepare("SELECT * FROM artifacts WHERE id = ?")
      .get(artifactId) as Row | undefined;
    if (row === undefined) throw new ArtifactNotFoundError(artifactId);
    return artifact(row);
  }

  list(ownerId: string, sessionId?: string): Artifact[] {
    const rows = (
      sessionId === undefined
        ? this.database
            .prepare(
              `SELECT * FROM artifacts
               WHERE owner_id = ? ORDER BY created_at DESC, id DESC`,
            )
            .all(ownerId)
        : this.database
            .prepare(
              `SELECT * FROM artifacts
               WHERE owner_id = ? AND session_id = ?
               ORDER BY created_at DESC, id DESC`,
            )
            .all(ownerId, sessionId)
    ) as Row[];
    return rows.map(artifact);
  }

  review(artifactId: string): ArtifactReview {
    const current = this.get(artifactId);
    const existing = this.database
      .prepare("SELECT * FROM artifact_reviews WHERE artifact_id = ?")
      .get(artifactId) as Row | undefined;
    if (existing !== undefined) {
      const persisted = review(existing);
      const validStatuses: ArtifactStatus[] = persisted.passed
        ? ["review_pending", "approved", "exported"]
        : ["review_failed"];
      if (!validStatuses.includes(current.status)) {
        throw new ArtifactStateError("artifact_state_corrupt");
      }
      return persisted;
    }
    if (current.status !== "draft") {
      throw new ArtifactStateError("artifact_state_corrupt");
    }
    const errors =
      current.kind === "research"
        ? researchReviewErrors(current)
        : contentReviewErrors(current, this.get(current.research_artifact_id));
    const passed = errors.length === 0;
    this.writeTransaction(() => {
      this.database
        .prepare(
          `INSERT INTO artifact_reviews (id, artifact_id, passed, errors_json)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          `review_${randomUUID().replaceAll("-", "")}`,
          artifactId,
          Number(passed),
          JSON.stringify(errors),
        );
      this.setStatus(artifactId, passed ? "review_pending" : "review_failed");
    });
    return review(
      this.database
        .prepare("SELECT * FROM artifact_reviews WHERE artifact_id = ?")
        .get(artifactId) as Row,
    );
  }

  approve(
    artifactId: string,
    actorId: string,
    ownerId: string,
  ): ArtifactApproval {
    const current = this.get(artifactId);
    if (current.owner_id !== ownerId) {
      throw new ArtifactNotFoundError(artifactId);
    }
    const existing = this.database
      .prepare("SELECT * FROM artifact_approvals WHERE artifact_id = ?")
      .get(artifactId) as Row | undefined;
    if (existing !== undefined) {
      if (!["approved", "exported"].includes(current.status)) {
        throw new ArtifactStateError("artifact_state_corrupt");
      }
      return approval(existing);
    }
    if (current.status !== "review_pending") {
      throw new ArtifactStateError("artifact_not_reviewed");
    }
    const id = `approval_${randomUUID().replaceAll("-", "")}`;
    this.writeTransaction(() => {
      this.database
        .prepare(
          `INSERT INTO artifact_approvals
               (id, artifact_id, actor_id, decision)
           VALUES (?, ?, ?, 'approved')`,
        )
        .run(id, artifactId, actorId);
      this.setStatus(artifactId, "approved");
    });
    return approval(
      this.database
        .prepare("SELECT * FROM artifact_approvals WHERE id = ?")
        .get(id) as Row,
    );
  }

  export(
    artifactId: string,
    target: "sandbox",
    ownerId: string,
  ): DeliveryReceipt {
    if (target !== "sandbox") {
      throw new ArtifactStateError("unsupported_delivery_target");
    }
    const current = this.get(artifactId);
    if (current.owner_id !== ownerId) {
      throw new ArtifactNotFoundError(artifactId);
    }
    const existing = this.database
      .prepare(
        `SELECT * FROM artifact_deliveries
         WHERE artifact_id = ? AND target = ?`,
      )
      .get(artifactId, target) as Row | undefined;
    if (existing !== undefined) {
      if (current.status !== "exported") {
        throw new ArtifactStateError("artifact_state_corrupt");
      }
      return delivery(existing);
    }
    if (current.status !== "approved") {
      throw new ArtifactStateError("artifact_not_approved");
    }
    const id = `delivery_${randomUUID().replaceAll("-", "")}`;
    const contentHash = createHash("sha256")
      .update(JSON.stringify(current))
      .digest("hex");
    this.writeTransaction(() => {
      this.database
        .prepare(
          `INSERT INTO artifact_deliveries
               (id, artifact_id, target, content_hash)
           VALUES (?, ?, ?, ?)`,
        )
        .run(id, artifactId, target, contentHash);
      this.setStatus(artifactId, "exported");
    });
    return delivery(
      this.database
        .prepare("SELECT * FROM artifact_deliveries WHERE id = ?")
        .get(id) as Row,
    );
  }

  getDelivery(deliveryId: string, ownerId: string): DeliveryReceipt {
    const row = this.database
      .prepare(
        `SELECT artifact_deliveries.*, artifacts.status AS artifact_status
         FROM artifact_deliveries
         JOIN artifacts ON artifacts.id = artifact_deliveries.artifact_id
         WHERE artifact_deliveries.id = ? AND artifacts.owner_id = ?`,
      )
      .get(deliveryId, ownerId) as Row | undefined;
    if (row === undefined) throw new DeliveryNotFoundError(deliveryId);
    if (text(row, "artifact_status") !== "exported") {
      throw new ArtifactStateError("artifact_state_corrupt");
    }
    return delivery(row);
  }

  private create<K extends Artifact["kind"]>(
    input: {
      idempotency_key: string;
      kind: K;
      owner_id: string;
      session_id: string;
      title: string;
      payload: Record<string, unknown>;
    },
    expectedKind: K,
  ): Extract<Artifact, { kind: K }> {
    const existing = this.database
      .prepare("SELECT * FROM artifacts WHERE idempotency_key = ?")
      .get(input.idempotency_key) as Row | undefined;
    if (existing !== undefined) {
      const value = this.get(text(existing, "id"));
      if (
        value.kind !== expectedKind ||
        text(existing, "owner_id") !== input.owner_id ||
        text(existing, "session_id") !== input.session_id ||
        text(existing, "title") !== input.title ||
        text(existing, "payload_json") !== JSON.stringify(input.payload)
      ) {
        throw new ArtifactStateError("artifact_idempotency_conflict");
      }
      return value as Extract<Artifact, { kind: K }>;
    }
    const id = `artifact_${randomUUID().replaceAll("-", "")}`;
    this.database
      .prepare(
        `INSERT INTO artifacts (
             id, idempotency_key, kind, owner_id, session_id, title,
             payload_json, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
      )
      .run(
        id,
        input.idempotency_key,
        input.kind,
        input.owner_id,
        input.session_id,
        input.title,
        JSON.stringify(input.payload),
      );
    return this.get(id) as Extract<Artifact, { kind: K }>;
  }

  private setStatus(artifactId: string, status: ArtifactStatus): void {
    this.database
      .prepare(
        `UPDATE artifacts
         SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .run(status, artifactId);
  }

  private writeTransaction<T>(run: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function researchReviewErrors(value: ResearchArtifact): string[] {
  const errors: string[] = [];
  const claimIds = new Set(value.claims.map((claim) => claim.id));
  const nodeIds = new Set(value.nodes.map((node) => node.id));
  if (value.claims.length === 0) errors.push("research_requires_claims");
  for (const claim of value.claims) {
    if (claim.source_ids.length === 0) {
      errors.push(`claim_requires_source:${claim.id}`);
    }
  }
  for (const relation of value.relations) {
    if (!nodeIds.has(relation.from) || !nodeIds.has(relation.to)) {
      errors.push(`relation_requires_nodes:${relation.from}:${relation.to}`);
    }
    if (!claimIds.has(relation.claim_id)) {
      errors.push(`relation_requires_claim:${relation.claim_id}`);
    }
  }
  return errors;
}

function contentReviewErrors(
  value: ContentArtifact,
  parent: Artifact,
): string[] {
  if (parent.kind !== "research") return ["content_requires_research"];
  const claimIds = new Set(parent.claims.map((claim) => claim.id));
  return value.channels.flatMap((channel) =>
    channel.claim_ids
      .filter((claimId) => !claimIds.has(claimId))
      .map((claimId) => `content_claim_not_in_research:${claimId}`),
  );
}

function artifact(row: Row): Artifact {
  const base = {
    id: text(row, "id"),
    owner_id: text(row, "owner_id"),
    session_id: text(row, "session_id"),
    title: text(row, "title"),
    status: text(row, "status"),
    created_at: text(row, "created_at"),
    updated_at: text(row, "updated_at"),
  };
  const payload = json(row, "payload_json") as Record<string, unknown>;
  const kind = text(row, "kind");
  if (kind === "research") {
    return ArtifactSchema.parse({
      ...base,
      kind: "research",
      summary: payload.summary,
      claims: payload.claims,
      nodes: payload.nodes,
      relations: payload.relations,
      unknowns: payload.unknowns,
    });
  }
  if (kind === "content") {
    return ArtifactSchema.parse({
      ...base,
      kind: "content",
      research_artifact_id: payload.research_artifact_id,
      channels: payload.channels,
    });
  }
  throw new ArtifactStateError("artifact_state_corrupt");
}

function review(row: Row): ArtifactReview {
  return {
    id: text(row, "id"),
    artifact_id: text(row, "artifact_id"),
    passed: integer(row, "passed") === 1,
    errors: json(row, "errors_json") as string[],
    created_at: text(row, "created_at"),
  };
}

function approval(row: Row): ArtifactApproval {
  return {
    id: text(row, "id"),
    artifact_id: text(row, "artifact_id"),
    actor_id: text(row, "actor_id"),
    decision: "approved",
    created_at: text(row, "created_at"),
  };
}

function delivery(row: Row): DeliveryReceipt {
  return {
    id: text(row, "id"),
    artifact_id: text(row, "artifact_id"),
    target: "sandbox",
    content_hash: text(row, "content_hash"),
    created_at: text(row, "created_at"),
  };
}

function json(row: Row, key: string): unknown {
  return JSON.parse(text(row, key)) as unknown;
}
