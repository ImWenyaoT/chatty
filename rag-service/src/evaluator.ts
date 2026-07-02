// LLM-judge 评估器：给每条客服回复打 score/issues/suggestions/suggestedReply。
// 独立成模块的原因：它此前寄生在 rag.ts 里，而 memory-store 的评分调度需要
// import 它，造成 memory-store ↔ rag 的循环依赖；评估器本身只依赖
// config/openai/prompts，与检索和记忆无关，放在这里依赖方向才是单向的。
import { config } from './config.js'
import { openai } from './openai.js'
import { loaded, renderTemplate } from './prompts-loader.js'

// 从自由文本中提取第一个配平的 JSON 对象（容忍模型在 JSON 前后加说明文字）。
function extractJsonFromText(text: string) {
  const start = text.indexOf('{')
  if (start < 0) return ''

  let depth = 0
  let inString = false
  let isEscaped = false

  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (isEscaped) {
      isEscaped = false
      continue
    }
    if (char === '\\') {
      isEscaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return text.slice(start)
}

// 把逗号/分号/换行分隔的自由列表文本切成干净的字符串数组。
function normalizeArrayText(raw: string): string[] {
  return raw
    .split(/\r?\n|；|;|，|,|、|\t/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^[-*\d.\s]*\s*/, '').trim())
}

// 从原始文本中按 key 提取 JSON 数组字段，解析失败退回文本切分。
function parseJsonArrayValue(rawText: string, key: string) {
  const regex = new RegExp(`['"]?${key}['"]?\\s*:\\s*(\\[[\\s\\S]*?\\])`, 'i')
  const match = rawText.match(regex)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[1])
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
  } catch {
    return normalizeArrayText(match[1].replace(/^\[|\]$/g, ''))
  }
}

// JSON 解析彻底失败时的宽松兜底：用正则从纯文本里抠 score/issues/suggestions。
function parseLooseEvaluation(rawText: string) {
  const normalized = rawText
    .replace(/：/g, ':')
    .replace(/，/g, ',')
    .replace(/“|”/g, '"')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')

  const scoreMatch = normalized.match(/(?:score|评分)\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)/i)
  const issuesMatch = normalized.match(
    /(?:issues|问题)\s*[:：]?\s*([\s\S]*?)(?:\n\s*(?:suggestions|建议)\s*[:：]?|$)/i,
  )
  const suggestionsMatch = normalized.match(/(?:suggestions|建议)\s*[:：]?\s*([\s\S]*?)(?:$)/i)

  const score = scoreMatch ? Number(scoreMatch[1]) : 0
  const issues = issuesMatch
    ? normalizeArrayText(issuesMatch[1]).slice(0, 3)
    : parseJsonArrayValue(normalized, 'issues').slice(0, 3)
  const suggestions = suggestionsMatch
    ? normalizeArrayText(suggestionsMatch[1]).slice(0, 3)
    : parseJsonArrayValue(normalized, 'suggestions').slice(0, 3)

  return {
    score: Number.isFinite(score) ? Math.min(10, Math.max(1, score)) : 0,
    issues,
    suggestions,
  }
}

export interface EvaluationResult {
  score: number
  issues: string[]
  suggestions: string[]
  suggestedReply?: string
  evaluatorModel: string
  promptVersion: string
}

// 调 LLM judge 给一条客服回复打分；解析端三层兜底（严格 JSON → 配平提取 → 宽松正则）。
export async function evaluateCustomerServiceReply(
  conversationHistory: Array<{ role: string; content: string }>,
  customerServiceReply: string,
): Promise<EvaluationResult> {
  const historyText = conversationHistory
    .map((message) => `${message.role === 'user' ? '用户' : '客服'}: ${message.content}`)
    .join('\n')

  const userPrompt = renderTemplate(loaded.prompts.evaluatorUserTemplate, {
    historyText,
    customerServiceReply,
  })

  const completion = await openai.chat.completions.create({
    model: config.evaluatorModel,
    temperature: 0.0,
    top_p: 1,
    max_tokens: 800,
    // DeepSeek 等 OpenAI 兼容后端不支持 json_schema structured outputs，统一用 json_object（JSON mode），
    // OpenAI 同样支持。解析端已用 extractJsonFromText + parseLooseEvaluation 兜底，不依赖 schema 强校验；
    // 字段结构由 evaluator 的 system/user 模板用文字约定。注意 json_object 模式要求 prompt 含 "json" 字样（已满足）。
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: loaded.prompts.evaluatorSystemPrompt },
      { role: 'user', content: userPrompt },
    ],
  })

  const rawText = completion.choices[0]?.message?.content ?? ''
  const jsonText = extractJsonFromText(rawText.trim())
  const baseMeta = { evaluatorModel: config.evaluatorModel, promptVersion: loaded.promptVersion }

  try {
    const parsed = JSON.parse(jsonText) as {
      score?: number
      issues?: string[]
      suggestions?: string[]
      suggestedReply?: string
    }
    const score = parsed.score != null ? Math.min(10, Math.max(1, Number(parsed.score))) : 0
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.map((item) => String(item)).slice(0, 3)
      : []
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map((item) => String(item)).slice(0, 3)
      : []
    const suggestedReply =
      typeof parsed.suggestedReply === 'string'
        ? parsed.suggestedReply.trim() || undefined
        : undefined

    if (score === 0) {
      throw new Error(`无效评分结果，rawText: ${rawText.slice(0, 500)}`)
    }

    return { score, issues, suggestions, suggestedReply, ...baseMeta }
  } catch (error) {
    console.error('评价解析失败:', error, 'rawText:', rawText)
    const fallback = parseLooseEvaluation(rawText)
    if (fallback.score === 0) {
      throw new Error(`评价解析失败且无法从原始输出恢复有效评分，rawText: ${rawText.slice(0, 500)}`)
    }
    return { ...fallback, ...baseMeta }
  }
}
