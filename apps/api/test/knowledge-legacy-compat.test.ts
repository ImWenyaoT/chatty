import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { KnowledgeStore } from "../src/knowledge.js";

test("TypeScript opens the legacy Python v1 FTS5 schema and ranking", () => {
  const directory = mkdtempSync(join(tmpdir(), "chatty-legacy-knowledge-"));
  const database = new DatabaseSync(join(directory, "legacy-python-v1.sqlite"));
  try {
    database.exec(`
      CREATE VIRTUAL TABLE knowledge_fts USING fts5(
        id UNINDEXED, title, summary, body, source UNINDEXED, tags,
        tokenize='trigram'
      );
      CREATE TABLE knowledge_character_index (
        record_rowid INTEGER NOT NULL,
        character TEXT NOT NULL,
        PRIMARY KEY (record_rowid, character)
      );
      CREATE INDEX knowledge_character_lookup
        ON knowledge_character_index (character, record_rowid);
      INSERT INTO knowledge_fts
        (rowid, id, title, summary, body, source, tags)
      VALUES
        (1, 'policy-rental-period-1', '租期计算', '租期从签收当天开始。',
         '租期从客户签收当天开始计算，到约定归还日期寄回即可。',
         'seller-policy://rental-period', '["租赁","租期"]');
      INSERT INTO knowledge_character_index (record_rowid, character)
      VALUES (1, '租'), (1, '期'), (1, '计'), (1, '算');
    `);
    const result = new KnowledgeStore(database).search("租期", 1);
    assert.equal(result.results[0]?.id, "policy-rental-period-1");
    assert.equal(result.results[0]?.source, "seller-policy://rental-period");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
