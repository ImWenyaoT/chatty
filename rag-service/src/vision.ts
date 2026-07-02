import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { openai } from './openai.js'

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
}

function resolveMediaDir() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(currentDir, '..', 'public', 'media')
}

async function toDataUrl(imageUrl: string): Promise<string | null> {
  if (imageUrl.startsWith('data:')) return imageUrl
  if (!imageUrl.startsWith('/media/')) return imageUrl // 外部 URL，直接透传
  const file = imageUrl.replace(/^\/media\//, '')
  if (!file || file.includes('..') || file.includes('/')) return null
  const ext = path.extname(file).slice(1).toLowerCase()
  const mime = MIME_BY_EXT[ext]
  if (!mime) return null
  try {
    const buf = await fs.readFile(path.join(resolveMediaDir(), file))
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

export interface CaptionOptions {
  imageUrl: string
  productId?: string
  productName?: string
  hint?: string
  mode?: 'catalog' | 'query'
}

/**
 * 用 vision 模型给图片生成描述。
 * - mode='catalog'：给商品图起检索 caption，输出侧重视角+关键特征
 * - mode='query'：给用户发来的图片解读"他在问什么"，输出侧重用户意图
 */
export async function describeImage(opts: CaptionOptions): Promise<string> {
  const dataUrl = await toDataUrl(opts.imageUrl)
  if (!dataUrl) throw new Error(`无法读取图片：${opts.imageUrl}`)

  const mode = opts.mode ?? 'catalog'

  const systemPrompt =
    mode === 'query'
      ? [
          '你是图片理解助手。用户在客服对话里发来了一张图片。',
          '请用一句 20-50 字的中文描述他发的是什么，重点说明：',
          '1) 图片类别（商品照片 / 尺码表 / 截图 / 模特图 / 其他）',
          '2) 关键视觉内容（款式、颜色、是否有尺码数据等）',
          '3) 如果看起来是在问某种商品款式，说明款式特征（西装/礼服/衬衫/裤装 等）',
          '只输出描述文字，不要前缀。',
        ].join('\n')
      : [
          '你是图片打标助手，专门给租赁电商的商品图生成检索 caption。',
          '一句 20-60 字中文描述，说清视角类型（正面/背面/侧面/细节/尺码对照表/裤脚/领口/袖口 等）+ 关键视觉特征。',
          '只输出 caption 文本，不要前缀或引号。',
        ].join('\n')

  const contextLine = [
    opts.productId ? `商品编号：${opts.productId}` : '',
    opts.productName ? `商品名称：${opts.productName}` : '',
    opts.hint ? `补充提示：${opts.hint}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const userText = contextLine
    ? `${mode === 'query' ? '请解读用户发来的这张图' : '请为下面这张商品图生成 caption'}。\n${contextLine}`
    : mode === 'query'
      ? '请解读用户发来的这张图。'
      : '请为下面这张商品图生成 caption。'

  const completion = await openai.chat.completions.create({
    model: config.chatModel,
    temperature: 0.2,
    max_tokens: 200,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] as unknown as string,
      },
    ],
  })

  const raw = completion.choices[0]?.message?.content ?? ''
  const out = String(raw)
    .trim()
    .replace(/^["'「『]|["'」』]$/g, '')
    .slice(0, 160)
  if (!out) throw new Error('vision 模型未返回有效描述')
  return out
}
