import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { config } from './config.js'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
// In tsx dev the loader lives at src/, so ../config resolves to the source
// config dir. When imported from the compiled dist/src/, ../config would point
// at dist/config (which is never populated). Fall back to the package root's
// config dir so answerQuestion() is importable in-process from dist too.
const distConfigDir = path.resolve(currentDir, '..', 'config')
const sourceConfigDir = path.resolve(currentDir, '..', '..', 'config')
const configDir = fs.existsSync(distConfigDir) ? distConfigDir : sourceConfigDir

export interface PromptsFile {
  stylistPrompt: string
  systemSupplement: string
  evaluatorSystemPrompt: string
  evaluatorUserTemplate: string
  factExtractorSystemPrompt: string
}

export interface SizeRule {
  minHeight: number
  maxHeight: number
  minWeight: number
  maxWeight: number
  size: string
  confidence: 'low' | 'medium' | 'high'
}

export interface ProductEntry {
  id: string
  name: string
  dailyPrice?: number
  renewalDailyPrice?: number
  currency?: string
  shippingPolicy?: string
  pricingNote?: string
}

export interface CatalogFile {
  products: ProductEntry[]
  sizeRules: SizeRule[]
  sizeFallback: {
    size: string
    confidence: 'low' | 'medium' | 'high'
  }
}

function readYaml<T>(filePath: string): { data: T; raw: string } {
  const raw = fs.readFileSync(filePath, 'utf8')
  return { data: YAML.parse(raw) as T, raw }
}

function shortHash(input: string) {
  return createHash('sha1').update(input).digest('hex').slice(0, 6)
}

function loadAll() {
  const versionName = config.promptVersionName
  const promptsPath = path.join(configDir, 'prompts', `${versionName}.yaml`)
  const catalogPath = path.join(configDir, 'catalog.yaml')

  const prompts = readYaml<PromptsFile>(promptsPath)
  const catalog = readYaml<CatalogFile>(catalogPath)

  const requiredPromptKeys: (keyof PromptsFile)[] = [
    'stylistPrompt',
    'systemSupplement',
    'evaluatorSystemPrompt',
    'evaluatorUserTemplate',
    'factExtractorSystemPrompt',
  ]
  for (const key of requiredPromptKeys) {
    if (!prompts.data?.[key]) {
      throw new Error(`[prompts-loader] ${promptsPath} missing field: ${key}`)
    }
  }
  if (!Array.isArray(catalog.data?.products)) {
    throw new Error(`[prompts-loader] ${catalogPath} missing products array`)
  }
  if (!Array.isArray(catalog.data?.sizeRules)) {
    throw new Error(`[prompts-loader] ${catalogPath} missing sizeRules array`)
  }

  const combinedRaw = `${prompts.raw}\n---\n${catalog.raw}`
  const promptVersion = `${versionName}-${shortHash(combinedRaw)}`

  return {
    versionName,
    promptVersion,
    prompts: prompts.data,
    catalog: catalog.data,
  }
}

export const loaded = loadAll()

export function findProduct(productId: string | undefined): ProductEntry | undefined {
  if (!productId) return undefined
  return loaded.catalog.products.find((item) => item.id === productId)
}

export function pickSizeByMeasurement(heightCm: number, weightKg: number) {
  const match = loaded.catalog.sizeRules.find(
    (rule) =>
      heightCm >= rule.minHeight &&
      heightCm <= rule.maxHeight &&
      weightKg >= rule.minWeight &&
      weightKg <= rule.maxWeight,
  )
  if (match) {
    return { size: match.size, confidence: match.confidence }
  }
  // 超出合理人体范围才真正交人工，避免给离谱输入硬套尺码
  if (heightCm < 140 || heightCm > 210 || weightKg < 35 || weightKg > 200) {
    return loaded.catalog.sizeFallback
  }
  // 最近邻兜底：落在尺码表空洞（如偏瘦高个 175/56）时，按到各规则矩形的欧氏距离取最近一档，
  // 给出确定的真码（M/L/XL）+ confidence:low + isFallback，而不是返回「尺码待人工确认」让 LLM 乱编。
  let best: { size: string; dist: number } | undefined
  for (const rule of loaded.catalog.sizeRules) {
    const dh =
      heightCm < rule.minHeight
        ? rule.minHeight - heightCm
        : heightCm > rule.maxHeight
          ? heightCm - rule.maxHeight
          : 0
    const dw =
      weightKg < rule.minWeight
        ? rule.minWeight - weightKg
        : weightKg > rule.maxWeight
          ? weightKg - rule.maxWeight
          : 0
    const dist = Math.hypot(dh, dw)
    if (!best || dist < best.dist) best = { size: rule.size, dist }
  }
  if (best) {
    return { size: best.size, confidence: 'low' as const, isFallback: true }
  }
  return loaded.catalog.sizeFallback
}

export function renderTemplate(template: string, vars: Record<string, string>) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) =>
    Object.hasOwn(vars, key) ? vars[key] : '',
  )
}
