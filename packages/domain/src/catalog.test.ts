// catalog 纯函数（findProduct / pickSizeByMeasurement）的单元测试。
// 用一份与 config/catalog.yaml 同构的内存目录对象覆盖：精确命中、区间边界、
// 人体范围外 fallback、尺码表空洞的最近邻兜底。
import assert from 'node:assert/strict'
import test from 'node:test'
import { type CatalogFile, findProduct, pickSizeByMeasurement } from './catalog.js'

// 与 config/catalog.yaml 相同的规则表（M/L/XL 三档 + 人工确认兜底）
const catalog: CatalogFile = {
  products: [
    {
      id: 'SUIT-001',
      name: '黑色双排扣西装',
      dailyPrice: 199,
      renewalDailyPrice: 99.5,
      currency: 'CNY',
      shippingPolicy: '寄出包邮，新疆、西藏等偏远地区除外',
      pricingNote: '第一天全价，续租半价，在途不算租期',
    },
  ],
  sizeRules: [
    {
      minHeight: 168,
      maxHeight: 174,
      minWeight: 55,
      maxWeight: 65,
      size: 'M',
      confidence: 'medium',
    },
    { minHeight: 175, maxHeight: 181, minWeight: 66, maxWeight: 80, size: 'L', confidence: 'high' },
    {
      minHeight: 182,
      maxHeight: 188,
      minWeight: 81,
      maxWeight: 92,
      size: 'XL',
      confidence: 'medium',
    },
  ],
  sizeFallback: { size: '尺码待人工确认', confidence: 'low' },
}

test('findProduct：按 ID 精确命中，返回完整商品条目', () => {
  const product = findProduct(catalog, 'SUIT-001')
  assert.equal(product?.name, '黑色双排扣西装')
  assert.equal(product?.dailyPrice, 199)
  assert.equal(product?.renewalDailyPrice, 99.5)
})

test('findProduct：productId 为空或未命中时返回 undefined', () => {
  assert.equal(findProduct(catalog, undefined), undefined)
  assert.equal(findProduct(catalog, ''), undefined)
  assert.equal(findProduct(catalog, 'SUIT-999'), undefined)
})

test('pickSizeByMeasurement：落在规则矩形内直接命中（含四角边界值）', () => {
  assert.deepEqual(pickSizeByMeasurement(catalog, 175, 70), { size: 'L', confidence: 'high' })
  // 区间边界（min/max 均为闭区间）
  assert.deepEqual(pickSizeByMeasurement(catalog, 168, 55), { size: 'M', confidence: 'medium' })
  assert.deepEqual(pickSizeByMeasurement(catalog, 174, 65), { size: 'M', confidence: 'medium' })
  assert.deepEqual(pickSizeByMeasurement(catalog, 188, 92), { size: 'XL', confidence: 'medium' })
})

test('pickSizeByMeasurement：超出人体合理范围（<140/>210cm、<35/>200kg）交人工兜底', () => {
  assert.deepEqual(pickSizeByMeasurement(catalog, 139, 70), catalog.sizeFallback)
  assert.deepEqual(pickSizeByMeasurement(catalog, 211, 70), catalog.sizeFallback)
  assert.deepEqual(pickSizeByMeasurement(catalog, 175, 34), catalog.sizeFallback)
  assert.deepEqual(pickSizeByMeasurement(catalog, 175, 201), catalog.sizeFallback)
})

test('pickSizeByMeasurement：尺码表空洞走最近邻，给真码 + confidence:low + isFallback', () => {
  // 偏瘦高个 175/56：距 L 档（66-80kg）10kg，距 M 档（<=174cm/55-65kg）1cm——最近邻是 M
  const thinTall = pickSizeByMeasurement(catalog, 175, 56)
  assert.deepEqual(thinTall, { size: 'M', confidence: 'low', isFallback: true })
  // 190/95：超出 XL 上界但仍在人体范围内，最近邻是 XL
  const big = pickSizeByMeasurement(catalog, 190, 95)
  assert.deepEqual(big, { size: 'XL', confidence: 'low', isFallback: true })
})

test('pickSizeByMeasurement：sizeRules 为空时（人体范围内）回落到 sizeFallback', () => {
  const empty: CatalogFile = { ...catalog, sizeRules: [] }
  assert.deepEqual(pickSizeByMeasurement(empty, 175, 70), catalog.sizeFallback)
})

test('pickSizeByMeasurement：纯函数——不修改入参 catalog', () => {
  const snapshot = structuredClone(catalog)
  pickSizeByMeasurement(catalog, 175, 56)
  findProduct(catalog, 'SUIT-001')
  assert.deepEqual(catalog, snapshot)
})
