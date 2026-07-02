// prompt 配置的类型形状 + promptVersion 计算。从 legacy rag-service/src/prompts-loader.ts 移植。
// 本文件是纯函数层：不碰 fs、无 import 期副作用（node:crypto 允许），
// 输入均为「已解析 / 原始字符串」形式，由 config-load.ts 或调用方注入。
// 哈希算法与 legacy 完全一致（sha1 前 6 位 + `${versionName}-` 前缀），
// 保证同一份 YAML 在重写前后算出同一个 promptVersion，评分对比不断档。

import { createHash } from 'node:crypto'

/** config/prompts/<version>.yaml 解析后的形状（五个字段全部必填） */
export interface PromptsFile {
  stylistPrompt: string
  systemSupplement: string
  evaluatorSystemPrompt: string
  evaluatorUserTemplate: string
  factExtractorSystemPrompt: string
}

/** sha1 短哈希：取十六进制摘要前 6 位（与 legacy shortHash 一致） */
export function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 6)
}

/**
 * 计算 promptVersion：`${versionName}-${sha1(promptsRaw + '\n---\n' + catalogRaw)前6位}`。
 * 入参是两份 YAML 的原始文本（不是解析后的对象），任何一字变动都会产生新版本号。
 */
export function computePromptVersion(
  versionName: string,
  promptsRaw: string,
  catalogRaw: string,
): string {
  const combinedRaw = `${promptsRaw}\n---\n${catalogRaw}`
  return `${versionName}-${shortHash(combinedRaw)}`
}

/** 渲染 {{var}} 占位符模板（evaluatorUserTemplate 等使用）；未提供的变量替换为空串 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) =>
    Object.hasOwn(vars, key) ? vars[key] : '',
  )
}
