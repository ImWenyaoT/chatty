import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  KnowledgeRecordSchema,
  KnowledgeSearchResultSchema,
  type KnowledgeRecord,
  type KnowledgeSearchResult,
} from "@chatty/contracts";
import { type SqliteRow as Row, text } from "./sqlite-row.js";

function recordFromRow(row: Row): KnowledgeRecord {
  return KnowledgeRecordSchema.parse({
    id: text(row, "id"),
    title: text(row, "title"),
    summary: text(row, "summary"),
    body: text(row, "body"),
    source: text(row, "source"),
    tags: JSON.parse(text(row, "tags")) as unknown,
  });
}

function lexicalFragments(query: string): string[] {
  const fragments: string[] = [];
  for (const term of query.match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (term.length < 3) continue;
    for (let index = 0; index <= term.length - 3; index += 1) {
      const fragment = term.slice(index, index + 3);
      if (!fragments.includes(fragment)) fragments.push(fragment);
    }
  }
  return fragments;
}

function queryTerms(query: string): string[] {
  return query.match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current.push(
        Math.min(
          current[current.length - 1]! + 1,
          previous[rightIndex]! + 1,
          previous[rightIndex - 1]! +
            Number(left[leftIndex - 1] !== right[rightIndex - 1]),
        ),
      );
    }
    previous = current;
  }
  return previous[previous.length - 1]!;
}

function hasCloseSubstring(value: string, term: string): boolean {
  const widths = new Set([
    Math.max(1, term.length - 1),
    term.length,
    term.length + 1,
  ]);
  for (const width of widths) {
    for (
      let start = 0;
      start < Math.max(0, value.length - width + 1);
      start += 1
    ) {
      if (editDistance(value.slice(start, start + width), term) <= 1)
        return true;
    }
  }
  return false;
}

export class KnowledgeStore {
  constructor(private readonly database: DatabaseSync) {
    this.database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
          id UNINDEXED,
          title,
          summary,
          body,
          source UNINDEXED,
          tags,
          tokenize='trigram'
      );
      CREATE TABLE IF NOT EXISTS knowledge_character_index (
          record_rowid INTEGER NOT NULL,
          character TEXT NOT NULL,
          PRIMARY KEY (record_rowid, character)
      );
      CREATE INDEX IF NOT EXISTS knowledge_character_lookup
          ON knowledge_character_index (character, record_rowid);
    `);
  }

  importJsonl(sourcePath: string): number {
    const records: KnowledgeRecord[] = [];
    const seenIds = new Set<string>();
    const lines = readFileSync(sourcePath, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let record: KnowledgeRecord;
      try {
        record = KnowledgeRecordSchema.parse(JSON.parse(line) as unknown);
      } catch {
        throw new Error(`invalid knowledge record on line ${index + 1}`);
      }
      if (seenIds.has(record.id)) {
        throw new Error(
          `duplicate knowledge id on line ${index + 1}: ${record.id}`,
        );
      }
      seenIds.add(record.id);
      records.push(record);
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(
        "DELETE FROM knowledge_fts; DELETE FROM knowledge_character_index;",
      );
      const insertRecord = this.database.prepare(
        `INSERT INTO knowledge_fts (rowid, id, title, summary, body, source, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertCharacter = this.database.prepare(
        `INSERT INTO knowledge_character_index (record_rowid, character)
         VALUES (?, ?)`,
      );
      for (const [index, record] of records.entries()) {
        const rowId = index + 1;
        insertRecord.run(
          rowId,
          record.id,
          record.title,
          record.summary,
          record.body,
          record.source,
          JSON.stringify(record.tags),
        );
        const searchable = `${record.title} ${record.summary} ${JSON.stringify(record.tags)}`;
        const characters = [
          ...new Set(searchable.match(/[\p{L}\p{N}_]/gu) ?? []),
        ].sort();
        for (const character of characters)
          insertCharacter.run(rowId, character);
      }
      this.database.exec("COMMIT");
      return records.length;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  search(query: string, limit: number): KnowledgeSearchResult {
    const normalized = query.trim().replace(/\s+/g, " ");
    if (!normalized) return { status: "ok", query, results: [], error: null };
    if (normalized.length > 500) {
      return {
        status: "error",
        query,
        results: [],
        error: "invalid_knowledge_query",
      };
    }
    try {
      return KnowledgeSearchResultSchema.parse({
        status: "ok",
        query,
        results: this.searchRows(
          normalized,
          Math.max(1, Math.min(limit, 10)),
        ).map(recordFromRow),
        error: null,
      });
    } catch {
      return {
        status: "error",
        query,
        results: [],
        error: "knowledge_search_unavailable",
      };
    }
  }

  private searchRows(query: string, limit: number): Row[] {
    const fragments = lexicalFragments(query);
    if (fragments.length > 0) {
      const expression = fragments
        .map((fragment) => `"${fragment.replaceAll('"', '""')}"`)
        .join(" OR ");
      const rows = this.database
        .prepare(
          `SELECT id, title, summary, body, source, tags
           FROM knowledge_fts
           WHERE knowledge_fts MATCH ?
           ORDER BY bm25(knowledge_fts), rowid
           LIMIT ?`,
        )
        .all(expression, limit) as Row[];
      if (rows.length > 0) return rows;
    }
    const terms = queryTerms(query);
    const exact = this.shortTermRows(terms, limit);
    return exact.length > 0 ? exact : this.fuzzyRows(terms, limit);
  }

  private shortTermRows(terms: string[], limit: number): Row[] {
    if (terms.length === 0) return [];
    const columns = ["title", "summary", "body", "tags"];
    const termClauses: string[] = [];
    const scoreClauses: string[] = [];
    const params: string[] = [];
    const scoreParams: string[] = [];
    for (const term of terms) {
      const escaped = term
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_");
      const pattern = `%${escaped}%`;
      const clause = columns
        .map((column) => `${column} LIKE ? ESCAPE '\\'`)
        .join(" OR ");
      termClauses.push(`(${clause})`);
      scoreClauses.push(`CASE WHEN ${clause} THEN 1 ELSE 0 END`);
      params.push(...columns.map(() => pattern));
      scoreParams.push(...columns.map(() => pattern));
    }
    return this.database
      .prepare(
        `SELECT id, title, summary, body, source, tags,
                (${scoreClauses.join(" + ")}) AS match_count
         FROM knowledge_fts
         WHERE ${termClauses.join(" OR ")}
         ORDER BY match_count DESC, rowid
         LIMIT ?`,
      )
      .all(...scoreParams, ...params, limit) as Row[];
  }

  private fuzzyRows(terms: string[], limit: number): Row[] {
    const fuzzyTerms = terms.filter(
      (term) => term.length >= 2 && term.length <= 10,
    );
    const characters = [...new Set(fuzzyTerms.join(""))];
    if (characters.length === 0) return [];
    const candidates = this.database
      .prepare(
        `SELECT knowledge_fts.id, title, summary, body, source, tags, knowledge_fts.rowid
         FROM knowledge_fts
         JOIN (
           SELECT record_rowid, COUNT(*) AS shared_characters
           FROM knowledge_character_index
           WHERE character IN (${characters.map(() => "?").join(", ")})
           GROUP BY record_rowid
           ORDER BY shared_characters DESC, record_rowid
           LIMIT 20
         ) AS candidate ON candidate.record_rowid = knowledge_fts.rowid`,
      )
      .all(...characters) as Row[];
    return candidates
      .map((row) => {
        const searchable = `${text(row, "title")} ${text(row, "summary")} ${text(row, "tags")}`;
        return {
          row,
          score: fuzzyTerms.filter((term) =>
            hasCloseSubstring(searchable, term),
          ).length,
          rowId: Number(row.rowid),
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort(
        (left, right) => right.score - left.score || left.rowId - right.rowId,
      )
      .slice(0, limit)
      .map((candidate) => candidate.row);
  }
}
