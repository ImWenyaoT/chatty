import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "./config.js";
import type { KnowledgeDocument, Product, UserProfile } from "./types.js";
import { userSegments } from "./types.js";

const cjk = /[\u4e00-\u9fff]/gu;
const sentenceEnd = /(?<=[。！？；])/u;

export const segmentForIndex = (text: string): string =>
  text.replace(cjk, (character) => ` ${character} `);

export function splitIntoChunks(
  text: string,
  target = 160,
  overlap = 40,
): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= target) return [normalized];

  const chunks: string[] = [];
  let current = "";
  for (const sentence of normalized
    .split(sentenceEnd)
    .filter((part) => part.trim())) {
    if (!current || current.length + sentence.length <= target) {
      current += sentence;
      continue;
    }
    chunks.push(current.trim());
    current = `${overlap ? current.slice(-overlap) : ""}${sentence}`;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

const schema = `
CREATE TABLE IF NOT EXISTS products (
  product_id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0), description TEXT NOT NULL,
  brand TEXT NOT NULL, seller_id TEXT NOT NULL, stock INTEGER NOT NULL CHECK (stock >= 0),
  tags_json TEXT NOT NULL, popularity_score REAL NOT NULL, image_url TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY, segment TEXT NOT NULL, preferred_categories_json TEXT NOT NULL,
  min_price_cents INTEGER NOT NULL, max_price_cents INTEGER NOT NULL,
  recent_views_json TEXT NOT NULL, recent_purchases_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS marketing_templates (
  segment TEXT PRIMARY KEY, tone TEXT NOT NULL, instructions TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS forbidden_words (word TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  content TEXT NOT NULL, category TEXT NOT NULL, product_id TEXT, source TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_documents_fts USING fts5(
  doc_id UNINDEXED, chunk_ordinal UNINDEXED, title, content, raw_content UNINDEXED,
  category, product_id UNINDEXED, tokenize = 'unicode61'
);`;

const parseJsonLines = <T>(path: string): T[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);

export class SeedDataError extends Error {}

export class Database {
  readonly connection: DatabaseSync;

  constructor(path = ":memory:", dataDir = DATA_DIR) {
    this.connection = new DatabaseSync(path);
    try {
      this.connection.exec("PRAGMA journal_mode = WAL");
      this.connection.exec(schema);
      this.seed(dataDir);
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  close(): void {
    this.connection.close();
  }

  private seed(dataDir: string): void {
    const products = parseJsonLines<Product>(join(dataDir, "products.jsonl"));
    const profiles = parseJsonLines<UserProfile>(
      join(dataDir, "user_profiles.jsonl"),
    );
    const knowledge = parseJsonLines<KnowledgeDocument>(
      join(dataDir, "knowledge_documents.jsonl"),
    );
    const templates = JSON.parse(
      readFileSync(join(dataDir, "marketing_templates.json"), "utf8"),
    ) as Record<string, { tone: string; instructions: string }>;
    const forbiddenWords = JSON.parse(
      readFileSync(join(dataDir, "forbidden_words.json"), "utf8"),
    ) as string[];

    if (
      Object.keys(templates).sort().join("|") !==
      [...userSegments].sort().join("|")
    ) {
      throw new SeedDataError("invalid_marketing_segments");
    }
    if (new Set(forbiddenWords).size !== forbiddenWords.length) {
      throw new SeedDataError("duplicate_forbidden_word");
    }

    const db = this.connection;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of [
        "knowledge_documents_fts",
        "knowledge_documents",
        "forbidden_words",
        "marketing_templates",
        "user_profiles",
        "products",
      ])
        db.exec(`DELETE FROM ${table}`);

      const insertProduct = db.prepare(
        `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of products)
        insertProduct.run(
          item.product_id,
          item.name,
          item.category,
          item.price_cents,
          item.description,
          item.brand,
          item.seller_id,
          item.stock,
          JSON.stringify(item.tags),
          item.popularity_score,
          item.image_url,
          item.source,
        );

      const insertProfile = db.prepare(
        `INSERT INTO user_profiles VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of profiles)
        insertProfile.run(
          item.user_id,
          item.segment,
          JSON.stringify(item.preferred_categories),
          item.min_price_cents,
          item.max_price_cents,
          JSON.stringify(item.recent_views),
          JSON.stringify(item.recent_purchases),
        );
      const insertTemplate = db.prepare(
        "INSERT INTO marketing_templates VALUES (?, ?, ?)",
      );
      for (const [segment, template] of Object.entries(templates)) {
        insertTemplate.run(segment, template.tone, template.instructions);
      }
      const insertForbidden = db.prepare(
        "INSERT INTO forbidden_words VALUES (?)",
      );
      for (const word of forbiddenWords) insertForbidden.run(word);

      const insertDocument = db.prepare(
        "INSERT INTO knowledge_documents (doc_id, title, content, category, product_id, source) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const insertChunk = db.prepare(
        "INSERT INTO knowledge_documents_fts (rowid, doc_id, chunk_ordinal, title, content, raw_content, category, product_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      let rowId = 0;
      for (const item of knowledge) {
        insertDocument.run(
          item.doc_id,
          item.title,
          item.content,
          item.category,
          item.product_id,
          item.source,
        );
        for (const [ordinal, chunk] of splitIntoChunks(
          item.content,
        ).entries()) {
          rowId += 1;
          insertChunk.run(
            rowId,
            item.doc_id,
            ordinal,
            segmentForIndex(item.title),
            segmentForIndex(chunk),
            chunk,
            item.category,
            item.product_id,
          );
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
