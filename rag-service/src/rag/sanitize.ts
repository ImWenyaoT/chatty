// 回复文本清洗：全仓库唯一实现。
// 此前 rag.ts（完整版）和 server.ts（只有后三条规则的残缺版）各有一份，
// 两份已经发散——server 对 rag 清洗过的文本二次清洗时行为不一致。收敛于此。
export function sanitizeAnswerText(text: string) {
  return text
    // 去掉 Markdown 图片语法 ![alt](url)——图片走独立的 imageReferences 卡片展示，
    // 文本里留着会让客户看到一串 "/media/xxx.jpg" 的原始路径，像暴露了后台。
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // 去掉普通 Markdown 链接 [text](url) 中的 url，保留 text——链接在聊天里没意义
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1')
    .replace(/\*/g, '')
    // 清掉图片去除后遗留的多余空行
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+([，。！？])/g, '$1')
    .replace(/([，。！？]){2,}/g, '$1')
    .trim();
}
