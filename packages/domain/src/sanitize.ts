// 回复文本清洗：全仓库唯一实现（从 legacy rag-service/src/rag/sanitize.ts 平移）。
// legacy 时代 rag.ts（完整版）和 server.ts（残缺版）各有一份且已发散，重写收敛于此。
/** 清洗 LLM/模板产出的回复文本：去 Markdown 痕迹、压空行、修标点 */
export function sanitizeAnswerText(text: string) {
  return (
    text
      // 去掉 Markdown 图片语法 ![alt](url)——图片通道随 RW-1 舍弃（imageReferences 卡片已删），
      // 但仍防御性清掉 LLM 可能编造的图片语法，避免客户看到 "/media/xxx.jpg" 原始路径。
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      // 去掉普通 Markdown 链接 [text](url) 中的 url，保留 text——链接在聊天里没意义
      .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1')
      .replace(/\*/g, '')
      // 清掉图片去除后遗留的多余空行
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s+([，。！？])/g, '$1')
      .replace(/([，。！？]){2,}/g, '$1')
      .trim()
  )
}
