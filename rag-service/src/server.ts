import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { z } from 'zod';
import { queryAvailability } from './availability-service.js';
import { config } from './config.js';
import {
  addKnowledge,
  deleteKnowledgeByPointIds,
  deleteKnowledgeByTitle,
  listKnowledge,
  type AddKnowledgeInput,
} from './knowledge-store.js';
import {
  addReview,
  appendConversationMemory,
  getAllCustomersForListing,
  getCustomerMemory,
  getProductMemory,
  getReviewSummary,
  markOrderPlaced,
  reEvaluateConversation,
} from './memory-store.js';
import { loaded } from './prompts-loader.js';
import { ensureCollection, isQdrantAvailable } from './qdrant.js';
import { answerQuestion } from './rag.js';

const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 });
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(currentDir, '..', 'public');

async function loadHtml(name: 'test.html') {
  return fs.readFile(path.join(publicDir, name), 'utf8');
}

async function tryReadBuffer(filePath: string): Promise<Buffer | null> {
  try { return await fs.readFile(filePath); } catch { return null; }
}

function contentTypeFor(filePath: string) {
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
}

function sanitizeAnswerText(text: string) {
  return text
    .replace(/\*/g, '')
    .replace(/\s+([，。！？])/g, '$1')
    .replace(/([，。！？]){2,}/g, '$1')
    .trim();
}

function resolveProductIntentText(productId?: string) {
  if (productId === 'SUIT-001') {
    return '黑色双排扣西装';
  }
  return undefined;
}

const chatRequestSchema = z.object({
  customerId: z.string().min(1),
  productId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  question: z.string().min(0).optional(),
  imageUrl: z.string().min(1).optional(),
  sessionContext: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  stylistPrompt: z.string().min(1).optional(),
}).refine((data) => (data.question && data.question.trim()) || data.imageUrl, {
  message: 'question 或 imageUrl 至少要提供一项',
});

const availabilityRequestSchema = z.object({
  productId: z.string().min(1),
  heightCm: z.number().positive(),
  weightKg: z.number().positive(),
  rentalStartDate: z.string().min(1),
  rentalEndDate: z.string().min(1),
});

const orderPlacementRequestSchema = z.object({
  customerId: z.string().min(1),
  productId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  orderNo: z.string().min(1),
});

app.get('/health', async () => ({ ok: true }));

app.get('/config/info', async () => ({
  promptVersion: loaded.promptVersion,
  promptVersionName: loaded.versionName,
  chatModel: config.chatModel,
  evaluatorModel: config.evaluatorModel,
  embeddingModel: config.embeddingModel,
  products: loaded.catalog.products.map((p) => ({ id: p.id, name: p.name })),
}));

app.get('/', async (_request, reply) => {
  return reply.type('text/html; charset=utf-8').send(await loadHtml('test.html'));
});

// React dashboard（取代旧 history.html）：index + 静态资源
const dashboardDir = path.join(publicDir, 'dashboard');

app.get('/history', async (_request, reply) => {
  const file = await fs.readFile(path.join(dashboardDir, 'index.html'), 'utf8');
  return reply.type('text/html; charset=utf-8').send(file);
});

app.get('/dashboard/assets/*', async (request, reply) => {
  const assetName = (request.params as { '*': string })['*'];
  // 防穿越
  if (assetName.includes('..')) return reply.status(400).send({ error: 'invalid path' });
  const filePath = path.join(dashboardDir, 'assets', assetName);
  const buf = await tryReadBuffer(filePath);
  if (!buf) return reply.status(404).send({ error: 'not found' });
  return reply.type(contentTypeFor(filePath)).send(buf);
});

app.get('/dashboard', async (_request, reply) => {
  return reply.redirect('/history');
});

app.get('/memory/:customerId', async (request, reply) => {
  const params = request.params as { customerId: string };
  const productId = typeof request.query === 'object' && request.query && 'productId' in request.query
    ? String((request.query as Record<string, unknown>).productId ?? '')
    : undefined;
  const customerMemory = await getCustomerMemory(params.customerId);
  const productMemory = productId ? await getProductMemory(params.customerId, productId) : null;

  return reply.send({
    customerMemory,
    productMemory,
  });
});

app.post('/availability/check', async (request, reply) => {
  const parsed = availabilityRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const result = await queryAvailability(parsed.data);
  return reply.send(result);
});

app.post('/orders/place', async (request, reply) => {
  const parsed = orderPlacementRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const memory = await markOrderPlaced(parsed.data);
  return reply.send({
    ok: true,
    orderNo: parsed.data.orderNo,
    memory: {
      customerId: memory.customerMemory.customerId,
      conversationId: memory.productMemory.conversationId,
      conversationProfile: memory.productMemory.conversationProfile,
      productSummary: memory.productMemory.summary,
      recentMessages: memory.productMemory.recentMessages,
    },
  });
});

app.post('/chat', async (request, reply) => {
  const parsed = chatRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  // 保证传给下游的 question 始终是 string，兼容旧 memory-store 的签名
  const normalizedInput = {
    ...parsed.data,
    question: parsed.data.question ?? '',
  };
  const result = await answerQuestion(normalizedInput);
  const sanitizedAnswer = sanitizeAnswerText(result.answer);
  // 记忆中记录原始问题（含图片 marker），方便后续回放
  const recordedQuestion = [
    parsed.data.question ?? '',
    parsed.data.imageUrl ? `[图片] ${parsed.data.imageUrl}` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .trim() || (parsed.data.imageUrl ? '[图片]' : '');
  const memory = await appendConversationMemory({
    customerId: parsed.data.customerId,
    productId: parsed.data.productId,
    conversationId: parsed.data.conversationId,
    question: recordedQuestion,
    answer: sanitizedAnswer,
    preExtractedFacts: result.extractedFacts,
    userIntent: result.intent?.intent,
    sessionContext: {
      ...(parsed.data.sessionContext ?? {}),
      productIntentText:
        parsed.data.sessionContext?.productIntentText
        ?? parsed.data.sessionContext?.productText
        ?? null,
      defaultProductText:
        parsed.data.sessionContext?.defaultProductText
        ?? resolveProductIntentText(parsed.data.productId)
        ?? null,
      handoffNeeded: result.handoff?.needed ?? null,
      handoffReason: result.handoff?.reason ?? null,
    },
  });

  return reply.send({
    ...result,
    answer: sanitizedAnswer,
    userImageUrl: parsed.data.imageUrl,
    memory: {
      customerId: memory.customerMemory.customerId,
      globalSummary: memory.customerMemory.globalSummary,
      bodyProfiles: memory.customerMemory.bodyProfiles,
      conversationId: memory.productMemory.conversationId,
      conversationProfile: memory.productMemory.conversationProfile,
      productSummary: memory.productMemory.summary,
      recentMessages: memory.productMemory.recentMessages,
    },
  });
});

app.get('/reviews/summary', async (_request, reply) => {
  const summary = await getReviewSummary();
  return reply.send(summary);
});

app.get('/memories/all', async (request, reply) => {
  const { page = 1, limit = 10 } = request.query as { page?: number; limit?: number };
  const customers = await getAllCustomersForListing();
  const start = (page - 1) * limit;
  const paginated = customers.slice(start, start + limit);
  return reply.send({ customers: paginated, total: customers.length, page, limit });
});

app.post('/reviews/evaluate', async (request, reply) => {
  const schema = z.object({
    customerId: z.string().min(1),
    productId: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
  });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  try {
    const result = await reEvaluateConversation(parsed.data);
    return reply.send(result);
  } catch (error) {
    return reply.status(500).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/reviews/add', async (request, reply) => {
  const schema = z.object({
    customerId: z.string().min(1),
    productId: z.string().min(1),
    rating: z.number().min(1).max(10),
    comment: z.string().optional(),
  });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }
  await addReview(parsed.data);
  return reply.send({ ok: true });
});

const sourceTypeEnum = z.enum(['rule', 'history', 'product']);
const contentTypeEnum = z.enum(['qa', 'text', 'image']);

const knowledgeListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  search: z.string().optional(),
  sourceType: z.union([sourceTypeEnum, z.literal('all')]).optional(),
  contentType: z.union([contentTypeEnum, z.literal('all')]).optional(),
  title: z.string().optional(),
});

const qaItemSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
});

const addKnowledgeSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('text'),
    title: z.string().min(1),
    text: z.string().min(1),
    sourceType: sourceTypeEnum,
  }),
  z.object({
    format: z.literal('markdown'),
    title: z.string().min(1),
    content: z.string().min(1),
    sourceType: sourceTypeEnum,
  }),
  z.object({
    format: z.literal('qa'),
    title: z.string().min(1),
    sourceType: sourceTypeEnum,
    items: z.array(qaItemSchema).min(1),
  }),
  z.object({
    format: z.literal('csv'),
    title: z.string().min(1),
    sourceType: sourceTypeEnum,
    csv: z.string().min(1),
  }),
  z.object({
    format: z.literal('json'),
    title: z.string().min(1),
    sourceType: sourceTypeEnum,
    content: z.string().min(1),
  }),
  z.object({
    format: z.literal('image'),
    title: z.string().min(1),
    sourceType: sourceTypeEnum,
    imageUrl: z.string().min(1),
    caption: z.string().min(1),
    tags: z.array(z.string().min(1)).optional(),
    relatedQuestions: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    format: z.literal('product'),
    productId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    attributes: z.array(z.object({ label: z.string().min(1), value: z.string().min(1) })).optional(),
    faqs: z.array(z.object({ question: z.string().min(1), answer: z.string().min(1) })).optional(),
    images: z
      .array(
        z.object({
          imageUrl: z.string().min(1),
          caption: z.string().min(1),
          tags: z.array(z.string().min(1)).optional(),
        }),
      )
      .optional(),
  }),
]);

const deleteKnowledgeSchema = z.union([
  z.object({ pointIds: z.array(z.string().min(1)).min(1) }),
  z.object({ title: z.string().min(1) }),
]);

const templateDir = path.join(publicDir, 'templates');
const templateManifest: Array<{
  key: string;
  file: string;
  contentType: string;
  downloadAs: string;
  label: string;
  matchesFormat: 'qa' | 'csv' | 'json' | 'markdown' | 'text';
  description: string;
}> = [
  {
    key: 'qa-csv',
    file: 'qa-template.csv',
    contentType: 'text/csv; charset=utf-8',
    downloadAs: 'qa-template.csv',
    label: 'Q&A · CSV（最推荐）',
    matchesFormat: 'csv',
    description: '每行一条问答，首行必须是 question,answer。切块粒度最细、检索命中率最高。',
  },
  {
    key: 'qa-json',
    file: 'qa-template.json',
    contentType: 'application/json; charset=utf-8',
    downloadAs: 'qa-template.json',
    label: 'Q&A · JSON 数组',
    matchesFormat: 'json',
    description: '程序化生成友好。系统会识别为 QA 并等价于 CSV 入库。',
  },
  {
    key: 'markdown',
    file: 'knowledge-template.md',
    contentType: 'text/markdown; charset=utf-8',
    downloadAs: 'knowledge-template.md',
    label: 'Markdown 段落',
    matchesFormat: 'markdown',
    description: '适合长段政策/说明。按 500 字自动切块、80 字重叠，建议用 Q&A 形小标题。',
  },
  {
    key: 'product-json',
    file: 'product-template.json',
    contentType: 'application/json; charset=utf-8',
    downloadAs: 'product-template.json',
    label: '商品档案 · JSON',
    matchesFormat: 'json',
    description: '结构化商品数据。系统会整体字符串化为一个文本块，建议随后用 Q&A 形态补录关键问答。',
  },
  {
    key: 'text',
    file: 'plaintext-template.txt',
    contentType: 'text/plain; charset=utf-8',
    downloadAs: 'plaintext-template.txt',
    label: '纯文本段落',
    matchesFormat: 'text',
    description: '次选。检索效果最弱，主要用于长段背景描述。能用 Q&A 就别用这个。',
  },
];

const mediaDir = path.join(publicDir, 'media');
const MEDIA_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

const mediaUploadSchema = z.object({
  filename: z.string().min(1).max(200).optional(),
  mimeType: z.string().min(1),
  base64: z.string().min(1),
});

app.post('/knowledge/media/upload', async (request, reply) => {
  const parsed = mediaUploadSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { mimeType, base64 } = parsed.data;
  const ext = MEDIA_MIME_EXT[mimeType.toLowerCase()];
  if (!ext) return reply.status(415).send({ error: `不支持的图片类型：${mimeType}` });

  // 允许传入 data URL（"data:image/png;base64,...."）或纯 base64
  const commaAt = base64.indexOf(',');
  const raw = base64.startsWith('data:') && commaAt >= 0 ? base64.slice(commaAt + 1) : base64;
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length === 0) return reply.status(400).send({ error: '图片内容为空或解码失败' });
  if (buffer.length > 8 * 1024 * 1024) {
    return reply.status(413).send({ error: '图片过大，超过 8MB 限制' });
  }

  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const fileName = `${hash}.${ext}`;
  await fs.mkdir(mediaDir, { recursive: true });
  const fullPath = path.join(mediaDir, fileName);
  await fs.writeFile(fullPath, buffer);
  return reply.send({
    ok: true,
    url: `/media/${fileName}`,
    fileName,
    size: buffer.length,
    mimeType,
  });
});

const captionRequestSchema = z.object({
  imageUrl: z.string().min(1).optional(),
  imageBase64: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  productId: z.string().min(1).optional(),
  productName: z.string().min(1).optional(),
  hint: z.string().min(1).optional(),
});

app.post('/knowledge/media/caption', async (request, reply) => {
  const parsed = captionRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { imageUrl, imageBase64, mimeType, productId, productName, hint } = parsed.data;

  // 优先用 base64 直传；否则尝试从 /media/<file> 读回硬盘再转 base64
  let dataUrl: string | undefined;
  if (imageBase64) {
    dataUrl = imageBase64.startsWith('data:')
      ? imageBase64
      : `data:${mimeType ?? 'image/png'};base64,${imageBase64}`;
  } else if (imageUrl) {
    const isLocal = imageUrl.startsWith('/media/');
    if (isLocal) {
      const file = imageUrl.replace(/^\/media\//, '');
      if (!file || file.includes('..') || file.includes('/')) {
        return reply.status(400).send({ error: 'invalid imageUrl' });
      }
      const ext = path.extname(file).slice(1).toLowerCase();
      const mime = MIME_BY_EXT[ext];
      if (!mime) return reply.status(400).send({ error: 'unsupported media type' });
      const buf = await tryReadBuffer(path.join(mediaDir, file));
      if (!buf) return reply.status(404).send({ error: 'image not found' });
      dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    } else {
      dataUrl = imageUrl; // 假定是可公开访问的外部 URL
    }
  } else {
    return reply.status(400).send({ error: 'imageUrl 或 imageBase64 至少提供一项' });
  }

  const contextLine = [
    productId ? `商品编号：${productId}` : '',
    productName ? `商品名称：${productName}` : '',
    hint ? `补充提示：${hint}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const systemPrompt = [
    '你是图片打标助手，专门给租赁电商的商品图生成「检索 caption」。',
    '目标：一句 20-60 字的中文描述，让客服系统通过向量检索能精准命中这张图。',
    '要点：',
    '1) 先判定视角类型（正面/背面/侧面/细节/尺码对照表/搭配示例/吊牌/面料特写/局部如裤脚/领口/袖口/腰带 等）',
    '2) 再描述关键视觉特征（颜色、版型、面料质感、是否含模特、重点部位）',
    '3) 如果是尺码表/说明图等功能性图，明确标注；不要臆造数据',
    '4) 尽量带上用户给出的商品编号或名称',
    '只输出 caption 文本，不要加前缀、引号或 Markdown。',
  ].join('\n');

  const userText = contextLine
    ? `请为下面这张商品图生成 caption。\n${contextLine}`
    : '请为下面这张商品图生成 caption。';

  try {
    void systemPrompt; void userText; // 旧 prompt 已由 describeImage 接管
    const caption = await (await import('./vision.js')).describeImage({
      imageUrl: imageUrl ?? `data:${mimeType ?? 'image/png'};base64,${(imageBase64 || '').replace(/^data:[^,]+,/, '')}`,
      productId,
      productName,
      hint,
      mode: 'catalog',
    });
    return reply.send({ ok: true, caption, model: config.chatModel });
  } catch (error) {
    return reply
      .status(500)
      .send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/media/:file', async (request, reply) => {
  const { file } = request.params as { file: string };
  if (file.includes('..') || file.includes('/') || file.includes('\\')) {
    return reply.status(400).send({ error: 'invalid path' });
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return reply.status(400).send({ error: 'unsupported media type' });
  const filePath = path.join(mediaDir, file);
  const buf = await tryReadBuffer(filePath);
  if (!buf) return reply.status(404).send({ error: 'not found' });
  return reply
    .header('Content-Type', mime)
    .header('Cache-Control', 'public, max-age=604800, immutable')
    .send(buf);
});

app.get('/knowledge/templates', async (_request, reply) => {
  return reply.send({
    templates: templateManifest.map((t) => ({
      key: t.key,
      label: t.label,
      matchesFormat: t.matchesFormat,
      description: t.description,
      downloadUrl: `/knowledge/template/${t.key}`,
      downloadAs: t.downloadAs,
    })),
  });
});

app.get('/knowledge/template/:key', async (request, reply) => {
  const { key } = request.params as { key: string };
  const manifest = templateManifest.find((t) => t.key === key);
  if (!manifest) {
    return reply.status(404).send({ error: 'unknown template' });
  }
  const filePath = path.join(templateDir, manifest.file);
  const buf = await tryReadBuffer(filePath);
  if (!buf) return reply.status(404).send({ error: 'template file missing' });
  return reply
    .header('Content-Type', manifest.contentType)
    .header('Content-Disposition', `attachment; filename="${manifest.downloadAs}"`)
    .send(buf);
});

app.get('/knowledge/list', async (request, reply) => {
  const parsed = knowledgeListQuerySchema.safeParse(request.query ?? {});
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }
  try {
    const result = await listKnowledge(parsed.data);
    return reply.send(result);
  } catch (error) {
    return reply
      .status(500)
      .send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/knowledge/add', async (request, reply) => {
  const parsed = addKnowledgeSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }
  try {
    const result = await addKnowledge(parsed.data as AddKnowledgeInput);
    return reply.send({ ok: true, ...result });
  } catch (error) {
    return reply
      .status(500)
      .send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/knowledge/delete', async (request, reply) => {
  const parsed = deleteKnowledgeSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }
  try {
    const result = 'title' in parsed.data
      ? await deleteKnowledgeByTitle(parsed.data.title)
      : await deleteKnowledgeByPointIds(parsed.data.pointIds);
    return reply.send({ ok: true, ...result });
  } catch (error) {
    return reply
      .status(500)
      .send({ error: error instanceof Error ? error.message : String(error) });
  }
});

const start = async () => {
  if (await isQdrantAvailable()) {
    await ensureCollection();
  } else {
    app.log.warn('Qdrant unavailable, using local vector store fallback.');
  }
  await app.listen({ port: config.port, host: '0.0.0.0' });
};

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
