import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Db } from "./database.js";
import { nowIso } from "./database.js";

// 单 chunk 上限：markdown section 超过它才按段落再切。
const MAX_CHUNK_CHARS = 1200;

/** 知识语料类型，由 knowledge/ 下的顶层目录推断（§2.1 schema 的 source_type 列）。 */
export type KnowledgeSourceType = "rule" | "product" | "history";

/** 入 FTS5 索引的最小单元：正文 + 规则摘要 + 定位元数据。 */
export interface KnowledgeChunk {
  text: string;
  summary: string;
  docId: string;
  section: string;
  sourceType: KnowledgeSourceType;
}

/** syncKnowledgeIndex 的结果：是否重建 + 索引内 chunk 总数（幂等性可断言）。 */
export interface KnowledgeSyncResult {
  rebuilt: boolean;
  chunks: number;
}

/**
 * 幂等索引同步（§2.4 I1）：读全部源文件算 sha1，与 meta 表比对，一致则跳过；
 * 不一致时整体重建——DELETE 全表后按 docId 排序重插，rowid 显式赋值保证确定性。
 */
export function syncKnowledgeIndex(
  db: Db,
  knowledgeDir: string,
): KnowledgeSyncResult {
  const sources = listSourceFiles(knowledgeDir).map((file) => ({
    docId: relative(knowledgeDir, file).split(sep).join("/"),
    content: readFileSync(file, "utf8"),
  }));
  const hash = createHash("sha1");
  for (const source of sources)
    hash.update(source.docId).update("\0").update(source.content);
  const sourceHash = hash.digest("hex");

  const meta = db
    .prepare("SELECT source_hash FROM knowledge_index_meta WHERE id = 1")
    .get() as { source_hash: string } | undefined;
  if (meta?.source_hash === sourceHash) {
    const row = db
      .prepare("SELECT count(*) AS n FROM knowledge_chunks")
      .get() as { n: number };
    return { rebuilt: false, chunks: row.n };
  }

  const chunks = sources.flatMap((source) =>
    chunkKnowledgeFile(source.docId, source.content),
  );
  const insert = db.prepare(
    "INSERT INTO knowledge_chunks (rowid, text, summary, doc_id, section, source_type) VALUES (?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    db.prepare("DELETE FROM knowledge_chunks").run();
    chunks.forEach((chunk, index) => {
      insert.run(
        index + 1,
        chunk.text,
        chunk.summary,
        chunk.docId,
        chunk.section,
        chunk.sourceType,
      );
    });
    db.prepare(
      `INSERT INTO knowledge_index_meta (id, source_hash, built_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET source_hash = excluded.source_hash, built_at = excluded.built_at`,
    ).run(sourceHash, nowIso());
  })();
  return { rebuilt: true, chunks: chunks.length };
}

/** 按文件类型分块：.csv 走 QA 行级分块，其余按 markdown 语义分块（§2.1）。 */
export function chunkKnowledgeFile(
  docId: string,
  content: string,
): KnowledgeChunk[] {
  const sourceType = sourceTypeOf(docId);
  const fallbackTitle = (docId.split("/").pop() ?? docId).replace(
    /\.[^.]+$/,
    "",
  );
  const normalized = content.replace(/\r\n/g, "\n");
  return docId.toLowerCase().endsWith(".csv")
    ? chunkQaCsv(docId, normalized, sourceType, fallbackTitle)
    : chunkMarkdown(docId, normalized, sourceType, fallbackTitle);
}

/**
 * Markdown 分块：按 ## 二级标题切 section，一个 section 一个 chunk；无二级标题
 * 整文件一个 chunk；单 chunk 超上限再按段落切分。section 记标题链，摘要走 S1 规则。
 */
function chunkMarkdown(
  docId: string,
  content: string,
  sourceType: KnowledgeSourceType,
  fallbackTitle: string,
): KnowledgeChunk[] {
  const clean = sanitizeText(content);
  const docTitle = clean.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallbackTitle;
  const chunks: KnowledgeChunk[] = [];
  // 以 ## 行为界切开：首段是一级标题+前言，其后每段以 section 标题开头
  for (const part of clean.split(/^(?=##\s)/m)) {
    const trimmed = part.trim();
    const firstLine = trimmed.split("\n", 1)[0] ?? "";
    const sectionTitle = firstLine.startsWith("## ")
      ? firstLine.slice(3).trim()
      : undefined;
    const section = sectionTitle ? `${docTitle} › ${sectionTitle}` : docTitle;
    // 纯标题段（无正文行）不成 chunk，如只含一级标题的前言段
    if (!firstContentLine(trimmed)) continue;
    for (const piece of splitByParagraph(trimmed)) {
      chunks.push({
        text: piece,
        summary: makeSummary(section, piece),
        docId,
        section,
        sourceType,
      });
    }
  }
  return chunks;
}

/** QA CSV 分块：每行一个 chunk，text 为 Q/A 成对，摘要即 Q 行（§2.1/§2.3，内化自 legacy）。 */
function chunkQaCsv(
  docId: string,
  content: string,
  sourceType: KnowledgeSourceType,
  docTitle: string,
): KnowledgeChunk[] {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const header = lines[0]
    ? parseCsvLine(lines[0]).map((cell) => cell.toLowerCase())
    : [];
  if (
    header.length !== 2 ||
    header[0] !== "question" ||
    header[1] !== "answer"
  ) {
    throw new Error(`[knowledge-index] ${docId} 首行必须是 question,answer`);
  }
  return lines.slice(1).map((line, index) => {
    const cols = parseCsvLine(line);
    if (cols.length !== 2 || !cols[0] || !cols[1]) {
      throw new Error(
        `[knowledge-index] ${docId} 第 ${index + 2} 行必须恰好两列且均非空`,
      );
    }
    const summary = `Q: ${cols[0]}`;
    return {
      text: `${summary}\nA: ${cols[1]}`,
      summary,
      docId,
      section: docTitle,
      sourceType,
    };
  });
}

/** 解析一行 CSV：支持双引号包裹含逗号字段与 "" 转义（qa-examples.csv 的标准格式）。 */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else current += char;
  }
  values.push(current.trim());
  return values;
}

/**
 * 内容卫生（§3.2）：入索引前剥离 markdown 图片行与图片链接行，防止 /media/ 等
 * 内部路径被 LLM 原样复制给客户（legacy action-picker 真实事故的索引期前移）。
 */
function sanitizeText(text: string): string {
  return text
    .split("\n")
    .filter(
      (line) => !/^\s*(Markdown\s*:\s*)?!\[[^\]]*\]\([^)]*\)\s*$/.test(line),
    )
    .filter((line) => !/^\s*图片链接\s*:/.test(line))
    .join("\n")
    .trim();
}

/** 超长 chunk 按段落边界贪心打包成 ≤MAX_CHUNK_CHARS 的片段；单段超限时整段保留。 */
function splitByParagraph(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const pieces: string[] = [];
  let current = "";
  for (const para of text.split(/\n\s*\n/)) {
    const merged = current ? `${current}\n\n${para}` : para;
    if (current && merged.length > MAX_CHUNK_CHARS) {
      pieces.push(current);
      current = para;
    } else current = merged;
  }
  if (current) pieces.push(current);
  return pieces;
}

/** 摘要 = 标题链 › 正文首行截 60 字——索引期规则生成，确定性零成本（§2.3 S1）。 */
function makeSummary(section: string, text: string): string {
  return `${section} › ${(firstContentLine(text) ?? "").slice(0, 60)}`;
}

/** 取首个非空且非标题的正文行；整段只有标题时返回 undefined。 */
function firstContentLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
}

/** 由顶层目录推断语料类型：rules→rule、history→history，其余按 product 处理。 */
function sourceTypeOf(docId: string): KnowledgeSourceType {
  if (docId.startsWith("rules/")) return "rule";
  if (docId.startsWith("history/")) return "history";
  return "product";
}

/** 递归收集 .md/.csv 源文件，按路径字典序排序，保证 hash 与 rowid 双重确定性。 */
function listSourceFiles(knowledgeDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(md|csv)$/i.test(entry.name)) files.push(full);
    }
  };
  walk(knowledgeDir);
  return files.sort();
}
