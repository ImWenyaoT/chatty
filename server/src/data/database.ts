/** SQLite 数据库及知识文档索引。 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { z } from "zod";

import {
  USER_SEGMENTS,
  knowledgeDocumentSchema,
  productSchema,
  userProfileSchema,
} from "./models.ts";

export const PROJECT_ROOT = new URL("../../../", import.meta.url);
export const DATA_DIR = new URL("data/", PROJECT_ROOT);

const CHINESE_CHARACTER = /[\u4e00-\u9fff]/gu;
const SENTENCE_END = /(?<=[。！？；])/u;

/** 在中文字符两侧加空格，让 SQLite unicode61 能按字建立索引。 */
export function segmentForIndex(text: string): string {
  return text.replace(CHINESE_CHARACTER, (character) => ` ${character} `);
}

/** 优先在中文句末切块；跨块保留少量重叠上下文。 */
export function splitIntoChunks(text: string, target = 160, overlap = 40): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  // Python 的 len() 与切片按码点计数，JS 的 length 按 UTF-16 单元，这里统一到码点。
  if ([...normalized].length <= target) return [normalized];

  const chunks: string[] = [];
  let current = "";
  const sentences = normalized.split(SENTENCE_END).filter((part) => part.trim());

  for (const sentence of sentences) {
    if (!current || [...current].length + [...sentence].length <= target) {
      current += sentence;
      continue;
    }

    chunks.push(current.trim());
    const prefix = overlap > 0 ? [...current].slice(-overlap).join("") : "";
    current = prefix + sentence;
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  product_id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0), description TEXT NOT NULL,
  brand TEXT NOT NULL, seller_id TEXT NOT NULL,
  stock INTEGER NOT NULL CHECK (stock >= 0),
  tags_json TEXT NOT NULL, popularity_score REAL NOT NULL, image_url TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY, segment TEXT NOT NULL,
  preferred_categories_json TEXT NOT NULL,
  min_price_cents INTEGER NOT NULL, max_price_cents INTEGER NOT NULL,
  recent_views_json TEXT NOT NULL, recent_purchases_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS marketing_templates (
  segment TEXT PRIMARY KEY, tone TEXT NOT NULL, instructions TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS forbidden_words (word TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  content TEXT NOT NULL, category TEXT NOT NULL, product_id TEXT, source TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_documents_fts USING fts5(
  doc_id UNINDEXED, chunk_ordinal UNINDEXED, title, content, raw_content UNINDEXED,
  category, product_id UNINDEXED, tokenize = 'unicode61'
);
`;

export class SeedDataError extends Error {}

function readText(dataDir: URL, name: string): string {
  return readFileSync(fileURLToPath(new URL(name, dataDir)), "utf8");
}

function readJsonLines<TSchema extends z.ZodType>(
  dataDir: URL,
  name: string,
  schema: TSchema,
): z.infer<TSchema>[] {
  return readText(dataDir, name)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => schema.parse(JSON.parse(line)) as z.infer<TSchema>);
}

/** 创建数据库，并把 JSON 种子投影为运行时 SQLite 数据。 */
export class Database {
  readonly connection: DatabaseSync;

  constructor(path: string = ":memory:", dataDir: URL = DATA_DIR) {
    this.connection = new DatabaseSync(path);

    try {
      this.connection.exec("PRAGMA journal_mode = WAL");
      this.connection.exec(SCHEMA);
      this.#seed(dataDir);
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  close(): void {
    this.connection.close();
  }

  #seed(dataDir: URL): void {
    const products = readJsonLines(dataDir, "products.jsonl", productSchema);
    const profiles = readJsonLines(dataDir, "user_profiles.jsonl", userProfileSchema);
    const documents = readJsonLines(
      dataDir,
      "knowledge_documents.jsonl",
      knowledgeDocumentSchema,
    );
    const templates = JSON.parse(readText(dataDir, "marketing_templates.json")) as Record<
      string,
      { tone: string; instructions: string }
    >;
    const forbiddenWords = JSON.parse(
      readText(dataDir, "forbidden_words.json"),
    ) as string[];

    const segments = Object.keys(templates).sort();
    if (segments.join() !== [...USER_SEGMENTS].sort().join()) {
      throw new SeedDataError("invalid_marketing_segments");
    }
    if (new Set(forbiddenWords).size !== forbiddenWords.length) {
      throw new SeedDataError("duplicate_forbidden_word");
    }

    const connection = this.connection;
    try {
      connection.exec("BEGIN IMMEDIATE");
      for (const table of [
        "knowledge_documents_fts",
        "knowledge_documents",
        "forbidden_words",
        "marketing_templates",
        "user_profiles",
        "products",
      ]) {
        connection.exec(`DELETE FROM ${table}`);
      }

      const insertProduct = connection.prepare(
        "INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const product of products) {
        insertProduct.run(
          product.product_id,
          product.name,
          product.category,
          product.price_cents,
          product.description,
          product.brand,
          product.seller_id,
          product.stock,
          JSON.stringify(product.tags),
          product.popularity_score,
          product.image_url,
          product.source,
        );
      }

      const insertProfile = connection.prepare(
        "INSERT INTO user_profiles VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const profile of profiles) {
        insertProfile.run(
          profile.user_id,
          profile.segment,
          JSON.stringify(profile.preferred_categories),
          profile.min_price_cents,
          profile.max_price_cents,
          JSON.stringify(profile.recent_views),
          JSON.stringify(profile.recent_purchases),
        );
      }

      const insertTemplate = connection.prepare(
        "INSERT INTO marketing_templates VALUES (?, ?, ?)",
      );
      for (const [segment, template] of Object.entries(templates)) {
        insertTemplate.run(segment, template.tone, template.instructions);
      }
      const insertWord = connection.prepare("INSERT INTO forbidden_words VALUES (?)");
      for (const word of forbiddenWords) insertWord.run(word);

      const insertDocument = connection.prepare(
        `INSERT INTO knowledge_documents
           (doc_id, title, content, category, product_id, source)
           VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insertChunk = connection.prepare(
        `INSERT INTO knowledge_documents_fts
           (rowid, doc_id, chunk_ordinal, title, content,
            raw_content, category, product_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let rowId = 0;
      for (const document of documents) {
        insertDocument.run(
          document.doc_id,
          document.title,
          document.content,
          document.category,
          document.product_id,
          document.source,
        );
        splitIntoChunks(document.content).forEach((chunk, ordinal) => {
          rowId += 1;
          insertChunk.run(
            rowId,
            document.doc_id,
            ordinal,
            segmentForIndex(document.title),
            segmentForIndex(chunk),
            chunk,
            document.category,
            document.product_id,
          );
        });
      }
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  }
}
