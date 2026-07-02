// 商品目录 + 尺码规则。从 legacy rag-service/src/prompts-loader.ts 移植，
// 关键差异：不再读文件 / 不再依赖模块级单例（loaded），
// 全部改为「已解析的 catalog 对象」入参的纯函数——加载职责移交 config-load.ts。

/** 身高体重 → 尺码 的单条匹配规则（矩形区间，按顺序先命中先用） */
export interface SizeRule {
  minHeight: number
  maxHeight: number
  minWeight: number
  maxWeight: number
  size: string
  confidence: 'low' | 'medium' | 'high'
}

/** 商品目录里的一件商品（含定价与物流政策文案） */
export interface ProductEntry {
  id: string
  name: string
  dailyPrice?: number
  renewalDailyPrice?: number
  currency?: string
  shippingPolicy?: string
  pricingNote?: string
}

/** catalog.yaml 解析后的整体形状 */
export interface CatalogFile {
  products: ProductEntry[]
  sizeRules: SizeRule[]
  sizeFallback: {
    size: string
    confidence: 'low' | 'medium' | 'high'
  }
}

/** pickSizeByMeasurement 的返回：推荐尺码 + 置信度（+ 是否走了最近邻兜底） */
export interface SizePick {
  size: string
  confidence: 'low' | 'medium' | 'high'
  isFallback?: boolean
}

/** 按商品 ID 在目录里精确查找商品；productId 为空或未命中返回 undefined */
export function findProduct(
  catalog: CatalogFile,
  productId: string | undefined,
): ProductEntry | undefined {
  if (!productId) return undefined
  return catalog.products.find((item) => item.id === productId)
}

/** 按身高体重套尺码规则：先精确命中；超出人体合理范围交 fallback；尺码表空洞走最近邻 */
export function pickSizeByMeasurement(
  catalog: CatalogFile,
  heightCm: number,
  weightKg: number,
): SizePick {
  const match = catalog.sizeRules.find(
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
    return catalog.sizeFallback
  }
  // 最近邻兜底：落在尺码表空洞（如偏瘦高个 175/56）时，按到各规则矩形的欧氏距离取最近一档，
  // 给出确定的真码（M/L/XL）+ confidence:low + isFallback，而不是返回「尺码待人工确认」让 LLM 乱编。
  let best: { size: string; dist: number } | undefined
  for (const rule of catalog.sizeRules) {
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
    return { size: best.size, confidence: 'low', isFallback: true }
  }
  return catalog.sizeFallback
}
