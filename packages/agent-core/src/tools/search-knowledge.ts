import type { JsonValue, RuntimeTool } from "@rental/shared";

// search_knowledge：LLM 主动检索店铺知识库的
// 唯一入口。FTS5 语法不暴露给模型（转义在 db 仓储侧归零）、top-k 服务端固定、
// 结果为纯文本三段式；空结果与失败必须可区分，且都给模型可执行的下一步动作。

/** 服务端固定返回条数（§3.1 P1）：不给模型可调预算的旋钮，与工具描述同源维护。 */
export const SEARCH_KNOWLEDGE_TOP_K = 3;
// 截断两层设防（§3.2）：单条正文上限 + 单次结果总上限；条目原子追加，不截半条。
const MAX_HIT_CHARS = 800;
const MAX_OUTPUT_CHARS = 4000;

/** 工具依赖的最小检索面：结构性匹配 @rental/db 的 KnowledgeRepository.search。 */
export interface KnowledgeSearcher {
  search(query: string): Array<{ text: string; section: string }>;
}

/** 返回值结构（§3.2）：output 进消息流，matches/truncated 落 trace 供评测统计。 */
export type SearchKnowledgeResult = {
  output: string;
  matches: number;
  truncated: boolean;
  status: "ok" | "degraded";
  errorCode?: "knowledge_search_unavailable";
};

/**
 * 工厂：注入知识库仓储，返回 search_knowledge RuntimeTool。risk=low 由 policy 门
 * 自动放行，closed session 由 policy 拒绝；描述与参数文案为 §3.3/§3.1 终稿原文。
 */
export function createSearchKnowledgeTool(
  repo: KnowledgeSearcher,
): RuntimeTool<Record<string, JsonValue>, SearchKnowledgeResult> {
  return {
    name: "search_knowledge",
    description: `搜索店铺知识库。在回答租赁政策、计费与包邮口径、换码/退换、押金、清洗、
店铺信息（名称/电话）等事实性问题之前，必须先用本工具搜索，不要凭记忆回答。
知识库覆盖：租赁规则与计费口径、下单引导与客服话术（rules）；
黑色双排扣西装商品说明（products）；历史客服问答（history）。
返回最相关的前 ${SEARCH_KNOWLEDGE_TOP_K} 条，每条含出处和正文，结果超过 ${SEARCH_KNOWLEDGE_TOP_K} 条时会提示剩余数量。
没有命中时，换更短或同义的关键词再搜一次；已经拿到答案后，不要用相同的
关键词重复搜索。商品价格、尺码推荐、库存这类结构化事实优先用
get_product / check_availability，不要靠本工具。`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            '一个中文关键词，2 到 4 个字为宜，例如"换码"、"押金"、"清洗"、"店铺电话"。一次只搜一个词，不要用空格拼多个词，不要输入完整句子，不要带标点。',
        },
      },
      required: ["query"],
    },
    risk: "low",
    approvalRequired: false,
    async execute(input) {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      try {
        // 仓储是同步 better-sqlite3 调用，失败面只有 DB 异常，try/catch 即全部防线
        return formatSearchResult(query, repo.search(query));
      } catch {
        // 失败 ≠ 空结果（§3.2）：给模型降级指引而非抛错中断循环
        return {
          output:
            "知识库搜索暂时不可用。请基于已知信息谨慎回答，不确定的内容如实告知用户无法确认。",
          matches: 0,
          truncated: false,
          status: "degraded",
          errorCode: "knowledge_search_unavailable",
        };
      }
    },
  };
}

/** 命中列表 → 三段式纯文本（§3.2）：头行计数、编号条目（含出处）、截断提示尾行。 */
function formatSearchResult(
  query: string,
  hits: Array<{ text: string; section: string }>,
): SearchKnowledgeResult {
  if (hits.length === 0) {
    return {
      output: `未找到与"${query}"相关的内容。换更短或不同的关键词再试一次，例如把长短语拆成单个词。`,
      matches: 0,
      truncated: false,
      status: "ok",
    };
  }
  const top = hits.slice(0, SEARCH_KNOWLEDGE_TOP_K);
  const header =
    hits.length > top.length
      ? `找到 ${hits.length} 条相关内容，显示最相关的前 ${top.length} 条：`
      : `找到 ${hits.length} 条相关内容：`;
  const parts = [header];
  let total = header.length;
  let shown = 0;
  let clipped = false;
  for (const [index, hit] of top.entries()) {
    const text =
      hit.text.length > MAX_HIT_CHARS
        ? `${hit.text.slice(0, MAX_HIT_CHARS)}……[已截断]`
        : hit.text;
    const entry = `[${index + 1}] 来源：${hit.section}\n${text}`;
    // 总量到顶：停止追加条目（原子，不截半条），剩余数量在尾行说明
    if (total + entry.length > MAX_OUTPUT_CHARS) break;
    if (text !== hit.text) clipped = true;
    parts.push(entry);
    total += entry.length;
    shown += 1;
  }
  const hidden = hits.length - shown;
  if (hidden > 0) {
    parts.push(
      `（还有 ${hidden} 条未显示。如需更精确的结果，换更具体的关键词再搜一次。）`,
    );
  }
  return {
    output: parts.join("\n\n"),
    matches: hits.length,
    truncated: clipped || hidden > 0,
    status: "ok",
  };
}
