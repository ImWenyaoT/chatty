import { createHash } from 'node:crypto';
import path from 'node:path';
import { chunkText } from './chunking.js';
import { config } from './config.js';
import { readLocalVectors, writeLocalVectors } from './local-store.js';
import { isQdrantAvailable, qdrant } from './qdrant.js';
import { embedText } from './rag.js';
import { ContentType, KnowledgeChunk, SourceType, VectorPoint } from './types.js';

export function toPointId(value: string) {
  const hash = createHash('md5').update(value).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export interface KnowledgeEntrySummary {
  pointId: string;
  chunkId: string;
  text: string;
  sourceType: SourceType;
  contentType: ContentType;
  filePath: string;
  title: string;
  chunkIndex: number;
  imageUrl?: string;
  caption?: string;
}

export interface KnowledgeListResult {
  entries: KnowledgeEntrySummary[];
  total: number;
  page: number;
  limit: number;
  stats: {
    total: number;
    totalEntries: number;
    bySourceType: Record<SourceType, number>;
    entriesBySourceType: Record<SourceType, number>;
    byContentType: Record<ContentType, number>;
    byTitle: Array<{ title: string; count: number }>;
  };
}

export interface ListQuery {
  page?: number;
  limit?: number;
  search?: string;
  sourceType?: SourceType | 'all';
  contentType?: ContentType | 'all';
  title?: string;
}

function inferContentTypeFromPayload(payload: Record<string, unknown>): ContentType {
  const explicit = payload.contentType;
  if (explicit === 'qa' || explicit === 'text' || explicit === 'image') return explicit;
  const title = String(payload.title ?? '');
  const text = String(payload.text ?? '');
  if (payload.imageUrl) return 'image';
  if (/\.csv$/i.test(title)) return 'qa';
  if (/^Q:\s.*\nA:\s/i.test(text)) return 'qa';
  return 'text';
}

function normalizePayload(raw: Record<string, unknown>): KnowledgeChunk {
  const imageUrl = typeof raw.imageUrl === 'string' && raw.imageUrl ? raw.imageUrl : undefined;
  const caption = typeof raw.caption === 'string' && raw.caption ? raw.caption : undefined;
  return {
    id: String(raw.id ?? ''),
    text: String(raw.text ?? ''),
    sourceType: (raw.sourceType === 'rule' || raw.sourceType === 'history' || raw.sourceType === 'product'
      ? raw.sourceType
      : 'rule') as SourceType,
    contentType: inferContentTypeFromPayload(raw),
    filePath: String(raw.filePath ?? ''),
    title: String(raw.title ?? ''),
    chunkIndex: Number(raw.chunkIndex ?? 0),
    ...(imageUrl ? { imageUrl } : {}),
    ...(caption ? { caption } : {}),
  };
}

async function getAllPoints(): Promise<VectorPoint[]> {
  if (await isQdrantAvailable()) {
    const collected: VectorPoint[] = [];
    let offset: string | number | undefined;
    // scroll through qdrant
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await qdrant.scroll(config.qdrantCollection, {
        limit: 200,
        offset,
        with_payload: true,
        with_vector: false,
      });
      for (const point of result.points) {
        const payload = (point.payload ?? {}) as Record<string, unknown>;
        collected.push({
          id: String(point.id),
          vector: [],
          payload: normalizePayload(payload),
        });
      }
      if (!result.next_page_offset) break;
      offset = result.next_page_offset as string | number;
    }
    return collected;
  }
  const local = await readLocalVectors();
  return local.map((point) => ({
    id: point.id,
    vector: point.vector,
    payload: normalizePayload(point.payload as unknown as Record<string, unknown>),
  }));
}

export async function listKnowledge(query: ListQuery = {}): Promise<KnowledgeListResult> {
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(200, Math.max(1, query.limit ?? 20));
  const all = await getAllPoints();

  const bySourceType: Record<SourceType, number> = { rule: 0, history: 0, product: 0 };
  const byContentType: Record<ContentType, number> = { qa: 0, text: 0, image: 0 };
  const titlesBySourceType: Record<SourceType, Set<string>> = {
    rule: new Set(),
    history: new Set(),
    product: new Set(),
  };
  const titleMap = new Map<string, number>();
  for (const point of all) {
    bySourceType[point.payload.sourceType] = (bySourceType[point.payload.sourceType] ?? 0) + 1;
    byContentType[point.payload.contentType] = (byContentType[point.payload.contentType] ?? 0) + 1;
    titlesBySourceType[point.payload.sourceType].add(point.payload.title);
    titleMap.set(point.payload.title, (titleMap.get(point.payload.title) ?? 0) + 1);
  }
  const byTitle = Array.from(titleMap.entries())
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count);
  const entriesBySourceType: Record<SourceType, number> = {
    rule: titlesBySourceType.rule.size,
    history: titlesBySourceType.history.size,
    product: titlesBySourceType.product.size,
  };
  const totalEntries = titleMap.size;

  let filtered = all;
  if (query.sourceType && query.sourceType !== 'all') {
    filtered = filtered.filter((p) => p.payload.sourceType === query.sourceType);
  }
  if (query.contentType && query.contentType !== 'all') {
    filtered = filtered.filter((p) => p.payload.contentType === query.contentType);
  }
  if (query.title) {
    filtered = filtered.filter((p) => p.payload.title === query.title);
  }
  if (query.search) {
    const needle = query.search.toLowerCase();
    filtered = filtered.filter(
      (p) =>
        p.payload.text.toLowerCase().includes(needle) ||
        p.payload.title.toLowerCase().includes(needle),
    );
  }

  filtered.sort((a, b) => {
    const titleCmp = a.payload.title.localeCompare(b.payload.title);
    if (titleCmp !== 0) return titleCmp;
    return a.payload.chunkIndex - b.payload.chunkIndex;
  });

  const total = filtered.length;
  const start = (page - 1) * limit;
  const pageItems = filtered.slice(start, start + limit).map<KnowledgeEntrySummary>((point) => ({
    pointId: point.id,
    chunkId: point.payload.id,
    text: point.payload.text,
    sourceType: point.payload.sourceType,
    contentType: point.payload.contentType,
    filePath: point.payload.filePath,
    title: point.payload.title,
    chunkIndex: point.payload.chunkIndex,
    ...(point.payload.imageUrl ? { imageUrl: point.payload.imageUrl } : {}),
    ...(point.payload.caption ? { caption: point.payload.caption } : {}),
  }));

  return {
    entries: pageItems,
    total,
    page,
    limit,
    stats: {
      total: all.length,
      totalEntries,
      bySourceType,
      entriesBySourceType,
      byContentType,
      byTitle,
    },
  };
}

export async function deleteKnowledgeByPointIds(pointIds: string[]): Promise<{ deleted: number }> {
  if (pointIds.length === 0) return { deleted: 0 };
  if (await isQdrantAvailable()) {
    await qdrant.delete(config.qdrantCollection, {
      wait: true,
      points: pointIds,
    });
    return { deleted: pointIds.length };
  }
  const all = await readLocalVectors();
  const keepSet = new Set(pointIds);
  const next = all.filter((p) => !keepSet.has(p.id));
  await writeLocalVectors(next);
  return { deleted: all.length - next.length };
}

export async function deleteKnowledgeByTitle(title: string): Promise<{ deleted: number }> {
  const all = await getAllPoints();
  const toDelete = all.filter((p) => p.payload.title === title).map((p) => p.id);
  return deleteKnowledgeByPointIds(toDelete);
}

export type AddKnowledgeInput =
  | {
      format: 'text';
      title: string;
      text: string;
      sourceType: SourceType;
    }
  | {
      format: 'qa';
      title: string;
      sourceType: SourceType;
      items: Array<{ question: string; answer: string }>;
    }
  | {
      format: 'markdown';
      title: string;
      content: string;
      sourceType: SourceType;
    }
  | {
      format: 'csv';
      title: string;
      sourceType: SourceType;
      csv: string;
    }
  | {
      format: 'json';
      title: string;
      sourceType: SourceType;
      // 允许：纯文本数组 / QA 对象数组
      content: string;
    }
  | {
      format: 'image';
      title: string;
      sourceType: SourceType;
      imageUrl: string;
      caption: string;
      tags?: string[];
      relatedQuestions?: string[];
    }
  | {
      format: 'product';
      productId: string;
      name: string;
      description?: string;
      attributes?: Array<{ label: string; value: string }>;
      faqs?: Array<{ question: string; answer: string }>;
      images?: Array<{ imageUrl: string; caption: string; tags?: string[] }>;
    };

function sourceTypeToDir(sourceType: SourceType) {
  if (sourceType === 'rule') return 'rules';
  if (sourceType === 'history') return 'history';
  return 'products';
}

function sanitizeTitle(raw: string) {
  const cleaned = raw.trim().replace(/[\\/:*?"<>|]/g, '_');
  return cleaned || 'untitled';
}

function buildVirtualFilePath(title: string, sourceType: SourceType, ext: string) {
  const dir = sourceTypeToDir(sourceType);
  const base = title.endsWith(ext) ? title : `${title}${ext}`;
  return path.join(process.cwd(), 'docs', dir, base);
}

function buildQaCsv(items: Array<{ question: string; answer: string }>) {
  const escape = (raw: string) => {
    const needsQuote = /[",\n\r]/.test(raw);
    const body = raw.replace(/"/g, '""');
    return needsQuote ? `"${body}"` : body;
  };
  const header = 'question,answer';
  const rows = items
    .filter((item) => item.question.trim() && item.answer.trim())
    .map((item) => `${escape(item.question.trim())},${escape(item.answer.trim())}`);
  return [header, ...rows].join('\n');
}

function buildImageChunkText(opts: {
  caption: string;
  tags?: string[];
  relatedQuestions?: string[];
  imageUrl: string;
}) {
  const lines: string[] = [];
  lines.push(`[图片知识] ${opts.caption.trim()}`);
  if (opts.tags && opts.tags.length > 0) {
    lines.push(`标签: ${opts.tags.map((t) => t.trim()).filter(Boolean).join('、')}`);
  }
  if (opts.relatedQuestions && opts.relatedQuestions.length > 0) {
    lines.push(`相关问题: ${opts.relatedQuestions.map((q) => q.trim()).filter(Boolean).join(' | ')}`);
  }
  lines.push(`图片链接: ${opts.imageUrl}`);
  lines.push(`Markdown: ![${opts.caption.trim()}](${opts.imageUrl})`);
  return lines.join('\n');
}

function chunksFromProduct(input: Extract<AddKnowledgeInput, { format: 'product' }>): KnowledgeChunk[] {
  const productId = input.productId.trim();
  const name = input.name.trim();
  if (!productId) throw new Error('商品编号不能为空');
  if (!name) throw new Error('商品名称不能为空');
  const displayName = `${productId} · ${name}`;
  const title = sanitizeTitle(displayName);
  const filePath = buildVirtualFilePath(title, 'product', '.product');
  const chunks: KnowledgeChunk[] = [];
  let index = 0;

  const attributes = (input.attributes ?? []).filter((a) => a.label.trim() && a.value.trim());
  const faqs = (input.faqs ?? []).filter((f) => f.question.trim() && f.answer.trim());
  const images = (input.images ?? []).filter((img) => img.imageUrl && img.caption.trim());

  // 1) 概览 chunk —— 供宽泛问题（"这件是什么/介绍一下"）命中
  const overviewLines: string[] = [];
  overviewLines.push(`商品名称：${name}`);
  overviewLines.push(`商品编号：${productId}`);
  if (input.description && input.description.trim()) {
    overviewLines.push(`简介：${input.description.trim()}`);
  }
  if (attributes.length > 0) {
    overviewLines.push('核心属性：');
    for (const attr of attributes) {
      overviewLines.push(`- ${attr.label.trim()}：${attr.value.trim()}`);
    }
  }
  chunks.push({
    id: `${title}-${index}`,
    text: overviewLines.join('\n'),
    sourceType: 'product',
    contentType: 'text',
    filePath,
    title,
    chunkIndex: index++,
  });

  // 2) 每个属性展开成一条 Q&A —— 这是检索命中率最高的粒度
  for (const attr of attributes) {
    const label = attr.label.trim();
    const value = attr.value.trim();
    const questions = [
      `${name} 的${label}是什么？`,
      `${productId} ${label}`,
      `${name} ${label}`,
    ];
    const answer = `${name}（${productId}）的${label}：${value}。`;
    chunks.push({
      id: `${title}-${index}`,
      text: `Q: ${questions.join(' / ')}\nA: ${answer}`,
      sourceType: 'product',
      contentType: 'qa',
      filePath,
      title,
      chunkIndex: index++,
    });
  }

  // 3) 图片 chunk —— caption 会自动带上商品名前缀，提升跨商品检索精度
  for (const img of images) {
    const captionRaw = img.caption.trim();
    const prefixedCaption = captionRaw.includes(name) || captionRaw.includes(productId)
      ? captionRaw
      : `${name}（${productId}）· ${captionRaw}`;
    chunks.push({
      id: `${title}-${index}`,
      text: buildImageChunkText({
        caption: prefixedCaption,
        tags: [productId, name, ...(img.tags ?? [])],
        relatedQuestions: [
          `${name} 有没有图`,
          `${productId} 效果图`,
          `${name} ${captionRaw}`,
        ],
        imageUrl: img.imageUrl,
      }),
      sourceType: 'product',
      contentType: 'image',
      filePath,
      title,
      chunkIndex: index++,
      imageUrl: img.imageUrl,
      caption: prefixedCaption,
    });
  }

  // 4) 补充 FAQ
  for (const faq of faqs) {
    chunks.push({
      id: `${title}-${index}`,
      text: `Q: ${faq.question.trim()}\nA: ${faq.answer.trim()}`,
      sourceType: 'product',
      contentType: 'qa',
      filePath,
      title,
      chunkIndex: index++,
    });
  }

  return chunks;
}

function chunksFromInput(input: AddKnowledgeInput): KnowledgeChunk[] {
  if (input.format === 'product') {
    return chunksFromProduct(input);
  }
  const title = sanitizeTitle(input.title);
  if (input.format === 'image') {
    const filePath = buildVirtualFilePath(title, input.sourceType, '.image');
    const text = buildImageChunkText({
      caption: input.caption,
      tags: input.tags,
      relatedQuestions: input.relatedQuestions,
      imageUrl: input.imageUrl,
    });
    return [
      {
        id: `${title}-0`,
        text,
        sourceType: input.sourceType,
        contentType: 'image',
        filePath,
        title,
        chunkIndex: 0,
        imageUrl: input.imageUrl,
        caption: input.caption,
      },
    ];
  }
  if (input.format === 'text') {
    const filePath = buildVirtualFilePath(title, input.sourceType, '.txt');
    const chunks = chunkText(filePath, input.text);
    return chunks.map((chunk) => ({ ...chunk, sourceType: input.sourceType }));
  }
  if (input.format === 'markdown') {
    const filePath = buildVirtualFilePath(title, input.sourceType, '.md');
    const chunks = chunkText(filePath, input.content);
    return chunks.map((chunk) => ({ ...chunk, sourceType: input.sourceType }));
  }
  if (input.format === 'qa') {
    const csv = buildQaCsv(input.items);
    const filePath = buildVirtualFilePath(title, input.sourceType, '.csv');
    const chunks = chunkText(filePath, csv);
    return chunks.map((chunk) => ({ ...chunk, sourceType: input.sourceType }));
  }
  if (input.format === 'csv') {
    const filePath = buildVirtualFilePath(title, input.sourceType, '.csv');
    const chunks = chunkText(filePath, input.csv);
    return chunks.map((chunk) => ({ ...chunk, sourceType: input.sourceType }));
  }
  if (input.format === 'json') {
    const parsed = JSON.parse(input.content);
    const normalized = normalizeJsonKnowledge(parsed);
    if (normalized.kind === 'qa') {
      const csv = buildQaCsv(normalized.items);
      const filePath = buildVirtualFilePath(title, input.sourceType, '.csv');
      const chunks = chunkText(filePath, csv);
      return chunks.map((chunk) => ({ ...chunk, sourceType: input.sourceType }));
    }
    const filePath = buildVirtualFilePath(title, input.sourceType, '.txt');
    const chunks = chunkText(filePath, normalized.text);
    return chunks.map((chunk) => ({ ...chunk, sourceType: input.sourceType }));
  }
  throw new Error(`Unsupported format`);
}

function normalizeJsonKnowledge(
  value: unknown,
):
  | { kind: 'qa'; items: Array<{ question: string; answer: string }> }
  | { kind: 'text'; text: string } {
  if (Array.isArray(value)) {
    const items: Array<{ question: string; answer: string }> = [];
    let qaCompatible = true;
    for (const entry of value) {
      if (entry && typeof entry === 'object') {
        const obj = entry as Record<string, unknown>;
        const q = obj.question ?? obj.q ?? obj.Q;
        const a = obj.answer ?? obj.a ?? obj.A;
        if (typeof q === 'string' && typeof a === 'string' && q.trim() && a.trim()) {
          items.push({ question: q.trim(), answer: a.trim() });
          continue;
        }
      }
      qaCompatible = false;
      break;
    }
    if (qaCompatible && items.length > 0) {
      return { kind: 'qa', items };
    }
    return { kind: 'text', text: value.map((item) => JSON.stringify(item)).join('\n\n') };
  }
  if (value && typeof value === 'object') {
    return { kind: 'text', text: JSON.stringify(value, null, 2) };
  }
  return { kind: 'text', text: String(value ?? '') };
}

export async function addKnowledge(input: AddKnowledgeInput) {
  const chunks = chunksFromInput(input);
  if (chunks.length === 0) {
    throw new Error('未生成任何知识块，请检查输入内容是否为空');
  }

  // 防止同 title 的旧数据造成 chunkIndex 冲突：先删除同 title 的所有旧点
  const existing = await getAllPoints();
  const title = chunks[0].title;
  const sameTitlePointIds = existing
    .filter((p) => p.payload.title === title)
    .map((p) => p.id);
  if (sameTitlePointIds.length > 0) {
    await deleteKnowledgeByPointIds(sameTitlePointIds);
  }

  const points: VectorPoint[] = [];
  for (const chunk of chunks) {
    const vector = await embedText(chunk.text);
    points.push({
      id: toPointId(chunk.id),
      vector,
      payload: chunk,
    });
  }

  if (await isQdrantAvailable()) {
    await qdrant.upsert(config.qdrantCollection, {
      wait: true,
      points: points.map((point) => ({
        id: point.id,
        vector: point.vector,
        payload: { ...point.payload } as Record<string, unknown>,
      })),
    });
    return { added: points.length, replacedOldCount: sameTitlePointIds.length, title };
  }

  const current = await readLocalVectors();
  const next = current.concat(points);
  await writeLocalVectors(next);
  return { added: points.length, replacedOldCount: sameTitlePointIds.length, title };
}
