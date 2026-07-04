import type { Db } from './database.js'

/** 一条知识检索命中：chunk 正文 + 摘要 + 定位元数据（doc/section/语料类型）。 */
export interface KnowledgeSearchHit {
  text: string
  summary: string
  docId: string
  section: string
  sourceType: string
}

export interface KnowledgeRepository {
  /**
   * 全文检索（docs/agentic-search-design.md §2.2 T1）：全部查询词 ≥3 字时走
   * trigram MATCH 取 bm25 相关度序（同分按 rowid 打平）；含 <3 字词或 MATCH
   * 零命中时回退 LIKE（text 与 summary 两列，词间 AND，按 rowid 稳定排序）。
   * 零命中返回空数组。查询按空白切词，MATCH 语法不暴露——词在服务端转义成短语。
   */
  search(query: string): KnowledgeSearchHit[]
}

const HIT_COLUMNS = 'text, summary, doc_id, section, source_type'

/** 创建知识库检索仓储：读侧只有 search 一个方法，写侧归 syncKnowledgeIndex。 */
export function createKnowledgeRepository(db: Db): KnowledgeRepository {
  return {
    search(query) {
      const terms = query.trim().split(/\s+/).filter(Boolean)
      if (terms.length === 0) return []
      // trigram tokenizer 对 <3 字短语必然零命中（§2.2 实测），
      // 任一查询词过短时直接走 LIKE，不浪费一次注定失败的 MATCH。
      if (terms.every((term) => term.length >= 3)) {
        const matchExpr = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' ')
        const rows = db
          .prepare(
            `SELECT ${HIT_COLUMNS} FROM knowledge_chunks WHERE knowledge_chunks MATCH ?
             ORDER BY bm25(knowledge_chunks) ASC, rowid ASC`,
          )
          .all(matchExpr) as HitRow[]
        if (rows.length > 0) return rows.map(toHit)
      }
      const where = terms
        .map(() => "(text LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')")
        .join(' AND ')
      const params = terms.flatMap((term) => {
        const pattern = `%${escapeLike(term)}%`
        return [pattern, pattern]
      })
      const rows = db
        .prepare(`SELECT ${HIT_COLUMNS} FROM knowledge_chunks WHERE ${where} ORDER BY rowid ASC`)
        .all(...params) as HitRow[]
      return rows.map(toHit)
    },
  }
}

/** 转义 LIKE 模式元字符（% _ \），防止查询词被当成通配模式解释。 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&')
}

interface HitRow {
  text: string
  summary: string
  doc_id: string
  section: string
  source_type: string
}

/** 数据行 → 对外命中对象（snake_case → camelCase）。 */
function toHit(row: HitRow): KnowledgeSearchHit {
  return {
    text: row.text,
    summary: row.summary,
    docId: row.doc_id,
    section: row.section,
    sourceType: row.source_type,
  }
}
