import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { z } from 'zod';
import { queryAvailability } from './availability-service.js';
import { config } from './config.js';
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
import { sanitizeAnswerText } from './rag/sanitize.js';

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
  sessionContext: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
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

app.post('/media/upload', async (request, reply) => {
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
