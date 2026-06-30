// Action → 自然语言文本（由 LLM 生成）。
//
// 和 templates.ts 的关系：templates.ts 是 deterministic fallback；这里是主路径。
// LLM 调用失败 / 禁用词命中 / spec 缺失 → 回退到 renderAction(action)。
//
// 目标：让客户感觉不到是机器人。实现：Action-scoped prompt，每个 Action 只告诉 LLM 它该做的事。

import { config } from '../config.js';
import { loaded } from '../prompts-loader.js';
import { createTextResponse } from '../responses.js';
import type { MemoryMessage } from '../types.js';
import type { ActionContext } from './action-picker.js';
import { ACTION_SPECS, GLOBAL_FORBIDDEN_PATTERNS, SKIP_GENERATION_KINDS, type ActionSpec } from './action-specs.js';
import type { Action } from './actions.js';
import { renderAction } from './templates.js';

function buildSystemPrompt(spec: ActionSpec): string {
  const lines: string[] = [
    '你是一家服装租赁门店的真实客服店员（真人，不是 AI），正在用微信和客户聊天。',
    '',
    '## 说话风格',
    loaded.prompts.stylistPrompt,
    '',
    '## 本轮目标',
    spec.goal,
    '',
    '## 硬规则（违反会被拦截，直接失败）',
    ...spec.hardRules.map((r, i) => `${i + 1}. ${r}`),
    '',
    `## 长度限制`,
    `不超过 ${spec.maxSentences} 句，字符数 ≤ ${spec.maxChars}。`,
    '不使用 Markdown、编号列表、项目符号、换行。',
    '',
  ];

  if (spec.goodExamples && spec.goodExamples.length > 0) {
    lines.push('## 好的示例（可以按这种风格写）');
    spec.goodExamples.forEach((ex) => lines.push(`- "${ex}"`));
    lines.push('');
  }
  if (spec.badExamples && spec.badExamples.length > 0) {
    lines.push('## 坏的示例（绝对不要这样写）');
    spec.badExamples.forEach((ex) => lines.push(`- "${ex}"`));
    lines.push('');
  }

  lines.push(
    '## 通用禁令',
    '- 绝对不问胸围/腰围/肩宽/三围/常穿码/几 XL/M/L/尺码号/48/50/软尺',
    '- 绝对不问"整套还是两件套"',
    '- 绝对不自称 AI/机器人/智能助手/大语言模型',
    '- 不罗列商品类目（西装/礼服/衬衫之类让客户自己说）',
    '',
    '只输出要发给客户的那一段纯文本，不要前缀、不要"店员："、不要解释。',
  );
  return lines.join('\n');
}

function formatAction(action: Action): string {
  const lines: string[] = [`Action: ${action.kind}`];
  for (const [key, value] of Object.entries(action)) {
    if (key === 'kind') continue;
    if (value === undefined || value === null || value === '') continue;
    lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  return lines.join('\n');
}

function formatProfile(ctx: ActionContext): string {
  const profile = ctx.conversationProfile;
  const lines: string[] = [];
  if (ctx.effectiveProductText) lines.push(`商品：${ctx.effectiveProductText}`);
  else if (ctx.productId) lines.push(`商品ID：${ctx.productId}`);

  if (profile?.heightCm !== undefined) lines.push(`身高：${profile.heightCm}cm`);
  if (profile?.weightKg !== undefined) lines.push(`体重：${profile.weightKg}kg`);

  if (profile?.rentalPeriod?.startDate) {
    const r = profile.rentalPeriod;
    lines.push(`档期：${r.startDate}${r.endDate && r.endDate !== r.startDate ? ` 到 ${r.endDate}` : ''}`);
  }

  if (profile?.sizeRecommendation?.recommendedSize) {
    lines.push(`推荐尺码：${profile.sizeRecommendation.recommendedSize}`);
  }
  if (profile?.priceQuote?.dailyPrice !== undefined) {
    lines.push(`首日价：${profile.priceQuote.dailyPrice}元 / 续租每日：${profile.priceQuote.renewalDailyPrice ?? '?'}元`);
  }
  if (profile?.orderPlacement?.orderNo) lines.push(`订单号：${profile.orderPlacement.orderNo}`);

  return lines.length > 0 ? lines.join('\n') : '（尚无）';
}

function formatRecent(recent?: MemoryMessage[]): string {
  if (!recent || recent.length === 0) return '（没有历史对话）';
  return recent
    .slice(-6)
    .map((m) => `${m.role === 'user' ? '客户' : '店员'}：${m.content}`)
    .join('\n');
}

function buildUserPrompt(action: Action, ctx: ActionContext): string {
  return [
    '=== 最近几轮对话 ===',
    formatRecent(ctx.recentMessages),
    '',
    '=== 当前已知资料 ===',
    formatProfile(ctx),
    '',
    '=== 客户本轮刚发 ===',
    ctx.question,
    '',
    '=== 你要做的事（详细） ===',
    formatAction(action),
    '',
    '请用店员口吻发一条自然的微信消息给客户。',
  ].join('\n');
}

export async function generateText(action: Action, ctx: ActionContext): Promise<{ text: string; source: 'llm' | 'fallback' }> {
  // 已经由上游生成过文本（分类器 / 固定话术）
  if (SKIP_GENERATION_KINDS.has(action.kind)) {
    return { text: renderAction(action), source: 'fallback' };
  }

  const spec = ACTION_SPECS[action.kind];
  if (!spec) {
    return { text: renderAction(action), source: 'fallback' };
  }

  try {
    const raw = await createTextResponse({
      model: config.generationModel,
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 260,
      instructions: buildSystemPrompt(spec),
      input: [{ role: 'user', content: buildUserPrompt(action, ctx) }],
    });

    if (!raw) {
      return { text: renderAction(action), source: 'fallback' };
    }

    // 1. 硬性字符上限——超长直接 fallback（LLM 对"10 字以内"这种指令遵守度低）
    if (raw.length > spec.maxChars) {
      console.warn(`[generate-text] action=${action.kind} too long (${raw.length} > ${spec.maxChars}); fallback`);
      return { text: renderAction(action), source: 'fallback' };
    }

    // 2. 禁用词校验——命中就 fallback
    for (const pattern of GLOBAL_FORBIDDEN_PATTERNS) {
      if (pattern.test(raw)) {
        console.warn(`[generate-text] action=${action.kind} blocked by ${pattern.source}; fallback`);
        return { text: renderAction(action), source: 'fallback' };
      }
    }

    return { text: raw, source: 'llm' };
  } catch (error) {
    console.error(`[generate-text] action=${action.kind} failed:`, error instanceof Error ? error.message : String(error));
    return { text: renderAction(action), source: 'fallback' };
  }
}
