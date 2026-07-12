// LLM-judge 评估器：给每条客服回复打 score/issues/suggestions/suggestedReply。
// 从 legacy rag-service/src/evaluator.ts 原样搬来（R5），把原先对 rag-service 内部
// config/openai/prompts 的依赖改为 @rental/llm 的共享客户端 + 内联的评分 prompt 常量，
// 使 eval/ 自包含、不再依赖已退役的 rag-service。判分行为保持不变（测量保真）：
// EVALUATOR_MODEL env、temperature 0、max_tokens 2000、json_object 解析、
// 三层容错兜底（严格 JSON → 配平提取 → 宽松正则）。
import { createHash } from "node:crypto";
import { createOpenAiClientFromEnv, readLlmEnv } from "@rental/llm";

// 评估器 system prompt（原 config/prompts/v1.yaml:evaluatorSystemPrompt，随 judge 内联保真）。
const EVALUATOR_SYSTEM_PROMPT = `你是租赁客服质量评估专家。你的任务是基于会话历史严格客观地评估客服回复质量，并给出改进建议。
评估维度：
1. 准确性：回复是否基于事实（知识库、会话资料），有无编造或过度承诺。
2. 相关性：是否直接回应用户问题，不答非所问。
3. 推进度：是否合理推进流程（询问缺失信息、引导下单），避免无效追问。
4. 语气：是否自然、简洁、有门店店员的真实感，避免 AI 腔或客服话术模板。
5. 边界：是否遵守不主动扩散联系方式、不泄漏他人资料等规则。
请严格按 JSON Schema 输出。不要编造额外字段，不要输出说明文字。`;

// 评估器 user 模板（原 evaluatorUserTemplate）。占位符：{{historyText}} {{customerServiceReply}}。
const EVALUATOR_USER_TEMPLATE = `会话历史：
{{historyText}}

客服回复：
{{customerServiceReply}}

请按 JSON 输出：score(1-10)、issues(1-3 条主要问题)、suggestions(1-3 条改进建议)、suggestedReply(你认为更合适的一条改写回复，保持口语化、2-5 句)。`;

// 评分 prompt 版本追溯：两个常量内容的短哈希，作为 EvaluationResult 元数据（改 prompt 即变版本）。
const PROMPT_VERSION = `judge-${createHash("sha256")
  .update(EVALUATOR_SYSTEM_PROMPT + EVALUATOR_USER_TEMPLATE)
  .digest("hex")
  .slice(0, 6)}`;

// 惰性单例的评估客户端：env 在首个判分调用时才读，避免与 dotenv 的 import 顺序耦合。
let cachedClient: ReturnType<typeof createOpenAiClientFromEnv> | undefined;

/** 返回进程内共享的 OpenAI 兼容客户端（首次构建后缓存）。 */
function getClient(): ReturnType<typeof createOpenAiClientFromEnv> {
  if (!cachedClient) cachedClient = createOpenAiClientFromEnv();
  return cachedClient;
}

/** judge 使用的评估模型：显式 EVALUATOR_MODEL / EVALUATION_MODEL 优先，未设回退共享 CHAT_MODEL。 */
function resolveEvaluatorModel(): string {
  return (
    process.env.EVALUATOR_MODEL ??
    process.env.EVALUATION_MODEL ??
    readLlmEnv().chatModel
  );
}

/** 极简模板渲染：把 {{key}} 替换为 vars[key]，缺失填空串（原 prompts-loader.renderTemplate）。 */
function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) =>
    Object.hasOwn(vars, key) ? vars[key] : "",
  );
}

// 从自由文本中提取第一个配平的 JSON 对象（容忍模型在 JSON 前后加说明文字）。
function extractJsonFromText(text: string) {
  const start = text.indexOf("{");
  if (start < 0) return "";

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (char === "\\") {
      isEscaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

// 把逗号/分号/换行分隔的自由列表文本切成干净的字符串数组。
function normalizeArrayText(raw: string): string[] {
  return raw
    .split(/\r?\n|；|;|，|,|、|\t/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^[-*\d.\s]*\s*/, "").trim());
}

// 从原始文本中按 key 提取 JSON 数组字段，解析失败退回文本切分。
function parseJsonArrayValue(rawText: string, key: string) {
  const regex = new RegExp(`['"]?${key}['"]?\\s*:\\s*(\\[[\\s\\S]*?\\])`, "i");
  const match = rawText.match(regex);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return normalizeArrayText(match[1].replace(/^\[|\]$/g, ""));
  }
}

// JSON 解析彻底失败时的宽松兜底：用正则从纯文本里抠 score/issues/suggestions。
function parseLooseEvaluation(rawText: string) {
  const normalized = rawText
    .replace(/：/g, ":")
    .replace(/，/g, ",")
    .replace(/“|”/g, '"')
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const scoreMatch = normalized.match(
    /(?:score|评分)\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)/i,
  );
  const issuesMatch = normalized.match(
    /(?:issues|问题)\s*[:：]?\s*([\s\S]*?)(?:\n\s*(?:suggestions|建议)\s*[:：]?|$)/i,
  );
  const suggestionsMatch = normalized.match(
    /(?:suggestions|建议)\s*[:：]?\s*([\s\S]*?)(?:$)/i,
  );

  const score = scoreMatch ? Number(scoreMatch[1]) : 0;
  const issues = issuesMatch
    ? normalizeArrayText(issuesMatch[1]).slice(0, 3)
    : parseJsonArrayValue(normalized, "issues").slice(0, 3);
  const suggestions = suggestionsMatch
    ? normalizeArrayText(suggestionsMatch[1]).slice(0, 3)
    : parseJsonArrayValue(normalized, "suggestions").slice(0, 3);

  return {
    score: Number.isFinite(score) ? Math.min(10, Math.max(1, score)) : 0,
    issues,
    suggestions,
  };
}

export interface EvaluationResult {
  score: number;
  issues: string[];
  suggestions: string[];
  suggestedReply?: string;
  evaluatorModel: string;
  promptVersion: string;
}

// 调 LLM judge 给一条客服回复打分；解析端三层兜底（严格 JSON → 配平提取 → 宽松正则）。
export async function evaluateCustomerServiceReply(
  conversationHistory: Array<{ role: string; content: string }>,
  customerServiceReply: string,
  options: { signal?: AbortSignal } = {},
): Promise<EvaluationResult> {
  const historyText = conversationHistory
    .map(
      (message) =>
        `${message.role === "user" ? "用户" : "客服"}: ${message.content}`,
    )
    .join("\n");

  const userPrompt = renderTemplate(EVALUATOR_USER_TEMPLATE, {
    historyText,
    customerServiceReply,
  });

  const evaluatorModel = resolveEvaluatorModel();
  const completion = await getClient().chat.completions.create(
    {
      model: evaluatorModel,
      temperature: 0.0,
      top_p: 1,
      // v4-pro judge 的 issues+suggestions+suggestedReply 中文输出常超 800，导致 JSON 被
      // 截断、宽松解析抠不回真实分而钉在下限 1（在完美回复上打 1 分，污染金标测量）。
      // 提到 2000 让判分 JSON 完整，是测量保真修复（R4 定档），单 lane 后一样保留。
      max_tokens: 2000,
      // DeepSeek 等 OpenAI 兼容后端不支持 json_schema structured outputs，统一用 json_object（JSON mode），
      // OpenAI 同样支持。解析端已用 extractJsonFromText + parseLooseEvaluation 兜底，不依赖 schema 强校验；
      // 字段结构由 evaluator 的 system/user 模板用文字约定。注意 json_object 模式要求 prompt 含 "json" 字样（已满足）。
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EVALUATOR_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    },
    { signal: options.signal },
  );

  const rawText = completion.choices[0]?.message?.content ?? "";
  const jsonText = extractJsonFromText(rawText.trim());
  const baseMeta = { evaluatorModel, promptVersion: PROMPT_VERSION };

  try {
    const parsed = JSON.parse(jsonText) as {
      score?: number;
      issues?: string[];
      suggestions?: string[];
      suggestedReply?: string;
    };
    const score =
      parsed.score != null
        ? Math.min(10, Math.max(1, Number(parsed.score)))
        : 0;
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.map((item) => String(item)).slice(0, 3)
      : [];
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map((item) => String(item)).slice(0, 3)
      : [];
    const suggestedReply =
      typeof parsed.suggestedReply === "string"
        ? parsed.suggestedReply.trim() || undefined
        : undefined;

    if (score === 0) {
      throw new Error(`无效评分结果，rawText: ${rawText.slice(0, 500)}`);
    }

    return { score, issues, suggestions, suggestedReply, ...baseMeta };
  } catch (error) {
    console.error("评价解析失败:", error, "rawText:", rawText);
    const fallback = parseLooseEvaluation(rawText);
    if (fallback.score === 0) {
      throw new Error(
        `评价解析失败且无法从原始输出恢复有效评分，rawText: ${rawText.slice(0, 500)}`,
      );
    }
    return { ...fallback, ...baseMeta };
  }
}
