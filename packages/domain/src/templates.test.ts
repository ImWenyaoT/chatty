// renderAction 模板渲染的单元测试：
// 1) 22 种 Action kind 每种至少一个渲染断言（文案来自 legacy，逐字平移）；
// 2) 全部模板输出过一遍 GLOBAL_FORBIDDEN_PATTERNS——确定性模板自身绝不能踩全局禁用词；
// 3) 关键分支（价格有无、日期解析、去重逻辑等）单独钉住。
import assert from 'node:assert/strict'
import test from 'node:test'
import { GLOBAL_FORBIDDEN_PATTERNS } from './action-specs.js'
import { isOrderActionKind, renderAction } from './templates.js'
import type { Action, ActionKind } from './types.js'

// 每种 kind 一个代表性实例（分支变体在下方专项测试里补），供全量断言与禁用词扫描复用
const representativeActions: Action[] = [
  { kind: 'greet' },
  { kind: 'repair', hint: '想问您租哪一款' },
  { kind: 'rental_howto', productId: 'SUIT-001', dailyPrice: 199, renewalDailyPrice: 99.5 },
  {
    kind: 'current_link_confirm',
    productText: '黑色双排扣西装',
    dailyPrice: 199,
    renewalDailyPrice: 99.5,
  },
  { kind: 'recall_body_empty' },
  { kind: 'recall_body_ambiguous', labels: ['本人', '孩子爸'] },
  { kind: 'post_order_delivery', rentalStartDate: '2026-7-10', needsHandoff: false },
  { kind: 'post_order_followup' },
  { kind: 'quote_price', dailyPrice: 199, renewalDailyPrice: 99.5, nextPrompt: '您把日期发我' },
  { kind: 'ask_product' },
  { kind: 'ask_period', productText: '黑色双排扣西装', missingBody: true, missingQuantity: true },
  { kind: 'ask_body', startDate: '2026-7-10', endDate: '2026-7-12', knownHeightCm: 175 },
  { kind: 'confirm_body_anomaly', weightKg: 175, suspicion: 'weight_too_high' },
  {
    kind: 'ack_body_measurement',
    isUpdating: false,
    heightCm: 175,
    weightKg: 70,
    inferredUnit: 'kg',
  },
  { kind: 'ack_rental_period', isUpdating: false, startDate: '2026-7-10', endDate: '2026-7-12' },
  { kind: 'confirm_size', size: 'L' },
  {
    kind: 'confirm_review',
    productText: '黑色双排扣西装',
    startDate: '2026-7-10',
    endDate: '2026-7-12',
    size: 'L',
    quantity: 1,
    quantityIsDefault: true,
  },
  { kind: 'guide_order', size: 'L', startDate: '2026-7-10', endDate: '2026-7-12', dailyPrice: 199 },
  { kind: 'check_availability' },
  {
    kind: 'answer_faq',
    text: '门店电话是 400-000-0000。',
    orchestrationFollowUp: '您把档期发我。',
  },
  { kind: 'small_talk', text: '哈哈好的，您忙～' },
  { kind: 'handoff', text: '这个问题我请店长来跟您确认下。', reason: '用户投诉' },
]

test('全量契约：22 种 kind 各渲染出非空文本，且不踩任何全局禁用词', () => {
  const kinds = new Set<ActionKind>()
  for (const action of representativeActions) {
    const text = renderAction(action)
    assert.ok(text.trim().length > 0, `${action.kind} 渲染出空文本`)
    for (const pattern of GLOBAL_FORBIDDEN_PATTERNS) {
      assert.ok(!pattern.test(text), `${action.kind} 模板输出命中禁用词 ${pattern}: ${text}`)
    }
    kinds.add(action.kind)
  }
  // 防止后续新增 Action kind 却忘了在这里补代表性用例
  assert.equal(kinds.size, 22)
})

// ---------- 快速路径 ----------

test('greet / recall_body_empty / check_availability / post_order_followup 固定话术', () => {
  assert.equal(renderAction({ kind: 'greet' }), '在呢，您说，我这边看着。')
  assert.match(renderAction({ kind: 'recall_body_empty' }), /还没有记录到您的身高体重/)
  assert.equal(
    renderAction({ kind: 'check_availability' }),
    '好，这边继续帮您对一下这个尺码的档期和库存。',
  )
  assert.match(renderAction({ kind: 'post_order_followup' }), /已经下单成功/)
})

test('repair：带 hint 复述那件事，不带 hint 用通用致歉', () => {
  assert.equal(
    renderAction({ kind: 'repair', hint: '想问您租哪一款' }),
    '不好意思，刚才说得不够清楚。想问您租哪一款，您看这样回我就行。',
  )
  assert.match(renderAction({ kind: 'repair' }), /您告诉我具体想了解哪一块/)
})

test('rental_howto：有价格报具体价，无价格说全价半价；有商品直接要档期体型', () => {
  const withPrice = renderAction({
    kind: 'rental_howto',
    productId: 'SUIT-001',
    dailyPrice: 199,
    renewalDailyPrice: 99.5,
  })
  assert.match(withPrice, /首日 199 元，续租一天 99\.5 元/)
  assert.match(withPrice, /身高体重发我/)
  const noPrice = renderAction({ kind: 'rental_howto' })
  assert.match(noPrice, /第一天全价，续租半价/)
  assert.match(noPrice, /想租的款式或者商品编号发我/)
  // 缺省物流政策必须带偏远地区除外
  assert.match(noPrice, /新疆、西藏等偏远地区除外/)
})

test('current_link_confirm：优先用 productText，无价格时不输出价格句', () => {
  const withText = renderAction({
    kind: 'current_link_confirm',
    productText: '黑色双排扣西装',
    dailyPrice: 199,
    renewalDailyPrice: 99.5,
  })
  assert.match(withText, /就是 黑色双排扣西装/)
  assert.match(withText, /首日 199 元/)
  const bare = renderAction({ kind: 'current_link_confirm' })
  assert.match(bare, /就是 这款/)
  assert.ok(!bare.includes('首日'))
})

test('recall_body_ambiguous：列出候选，无候选时说"其中一位"', () => {
  assert.match(
    renderAction({ kind: 'recall_body_ambiguous', labels: ['本人', '孩子爸'] }),
    /本人、孩子爸里的哪一位/,
  )
  assert.match(renderAction({ kind: 'recall_body_ambiguous', labels: [] }), /其中一位里的哪一位/)
})

test('post_order_delivery：四个分支——转人工 / 缺日期 / 可解析日期算前一天 / 不可解析兜底', () => {
  assert.match(renderAction({ kind: 'post_order_delivery', needsHandoff: true }), /跟快递那边确认/)
  assert.match(
    renderAction({ kind: 'post_order_delivery', needsHandoff: false }),
    /把开始使用那天发我/,
  )
  assert.match(
    renderAction({
      kind: 'post_order_delivery',
      rentalStartDate: '2026-7-10',
      needsHandoff: false,
    }),
    /一般是 7月9号 左右送到/,
  )
  assert.match(
    renderAction({ kind: 'post_order_delivery', rentalStartDate: '下周六', needsHandoff: false }),
    /开始使用日期前一天左右送到/,
  )
})

test('quote_price：有价报价并拼 nextPrompt，无价说全价半价', () => {
  assert.equal(
    renderAction({
      kind: 'quote_price',
      dailyPrice: 199,
      renewalDailyPrice: 99.5,
      nextPrompt: '您把日期发我',
    }),
    '这款第一天 199 元，续租一天 99.5 元，在途不算租期。 您把日期发我',
  )
  assert.equal(renderAction({ kind: 'quote_price' }), '这边是第一天全价，续租半价，在途不算租期。')
})

// ---------- 流程推进路径 ----------

test('ask_product：只问款式/颜色/编号', () => {
  assert.match(renderAction({ kind: 'ask_product' }), /款式、颜色或者商品编号发我/)
})

test('ask_period：缺体型/数量时一起问全，单缺档期时只问档期', () => {
  const all = renderAction({
    kind: 'ask_period',
    productText: '黑色双排扣西装',
    missingBody: true,
    missingQuantity: true,
  })
  assert.match(all, /"黑色双排扣西装"这边先给您记着了/)
  assert.match(all, /档期（哪天用、哪天归还）、身高、体重、数量（默认 1 件）发我，顺序不限/)
  const onlyPeriod = renderAction({ kind: 'ask_period' })
  assert.match(onlyPeriod, /当前这款这边先给您记着了/)
  assert.match(onlyPeriod, /我先帮您确认这个时间段能不能排上/)
})

test('ask_body：已知信息先复述，缺什么问什么；全齐时直接说马上对尺码', () => {
  const partial = renderAction({
    kind: 'ask_body',
    startDate: '2026-7-10',
    endDate: '2026-7-12',
    knownHeightCm: 175,
  })
  assert.match(partial, /2026-7-10 到 2026-7-12这边先给您记上了/)
  assert.match(partial, /身高 175cm先记下/)
  assert.match(partial, /您再把体重发我/)

  const nothing = renderAction({ kind: 'ask_body', missingPeriod: true, missingQuantity: true })
  assert.match(nothing, /身高、体重、档期（哪天用、哪天归还）、数量（默认 1 件）发我（顺序不限）/)

  const complete = renderAction({ kind: 'ask_body', knownHeightCm: 175, knownWeightKg: 70 })
  assert.match(complete, /信息齐了，我马上帮您对尺码/)
})

test('confirm_body_anomaly：体重过高给斤/身高二选一，身高异常提示笔误，缺数值走兜底', () => {
  const weight = renderAction({
    kind: 'confirm_body_anomaly',
    weightKg: 175,
    suspicion: 'weight_too_high',
  })
  assert.match(weight, /身高 175cm，还是体重 175 斤（差不多 88kg）/)
  assert.match(
    renderAction({ kind: 'confirm_body_anomaly', heightCm: 220, suspicion: 'height_too_high' }),
    /是不是笔误呀/,
  )
  assert.match(
    renderAction({ kind: 'confirm_body_anomaly', heightCm: 2, suspicion: 'height_too_low' }),
    /是不是把米写成了/,
  )
  assert.match(
    renderAction({ kind: 'confirm_body_anomaly', suspicion: 'weight_too_high' }),
    /再发一遍或者补充一下单位/,
  )
})

test('ack_body_measurement：更新/首记/单位口径三种话术 + 无数据兜底', () => {
  assert.equal(
    renderAction({ kind: 'ack_body_measurement', isUpdating: true, heightCm: 175 }),
    '好，这边先帮您把身高175cm更新了。',
  )
  assert.equal(
    renderAction({
      kind: 'ack_body_measurement',
      isUpdating: false,
      heightCm: 175,
      weightKg: 70,
      inferredUnit: 'kg',
    }),
    '好，您这边是身高175cm，体重70kg，我先给您记上。',
  )
  assert.equal(
    renderAction({
      kind: 'ack_body_measurement',
      isUpdating: false,
      weightKg: 70,
      inferredUnit: 'jin',
    }),
    '好，这边先记下，体重70kg。',
  )
  assert.match(
    renderAction({ kind: 'ack_body_measurement', isUpdating: false }),
    /还没识别到完整体型信息/,
  )
})

test('ack_rental_period：首记/改期/单端日期的话术矩阵', () => {
  assert.equal(
    renderAction({
      kind: 'ack_rental_period',
      isUpdating: false,
      startDate: '2026-7-10',
      endDate: '2026-7-12',
    }),
    '好，这边先记下，您是 2026-7-10 使用，2026-7-12 归还。',
  )
  assert.equal(
    renderAction({
      kind: 'ack_rental_period',
      isUpdating: true,
      startDate: '2026-7-11',
      endDate: '2026-7-13',
    }),
    '好，这边先帮您把时间改成 2026-7-11 到 2026-7-13。',
  )
  assert.equal(
    renderAction({ kind: 'ack_rental_period', isUpdating: true, endDate: '2026-7-13' }),
    '好，这边先帮您把归还时间改到 2026-7-13。',
  )
  assert.equal(
    renderAction({ kind: 'ack_rental_period', isUpdating: true, startDate: '2026-7-11' }),
    '好，这边先帮您把使用时间改到 2026-7-11。',
  )
  assert.equal(
    renderAction({ kind: 'ack_rental_period', isUpdating: false, endDate: '2026-7-13' }),
    '好，这边先记下归还时间是 2026-7-13。',
  )
  assert.equal(
    renderAction({
      kind: 'ack_rental_period',
      isUpdating: false,
      startDate: '2026-7-10',
      endDate: '2026-7-10',
    }),
    '好，这边先记下使用时间是 2026-7-10。',
  )
  assert.match(renderAction({ kind: 'ack_rental_period', isUpdating: false }), /还没识别到完整档期/)
})

test('confirm_size：给码 + 免费换码兜底；note 原样插入', () => {
  assert.equal(
    renderAction({ kind: 'confirm_size', size: 'L' }),
    '看您给的身高体重，这款您穿 L 码更合适。如果到手不合身，我们支持免费换码。',
  )
  assert.match(
    renderAction({ kind: 'confirm_size', size: 'M', note: '偏瘦建议收一码。' }),
    /偏瘦建议收一码。/,
  )
})

test('confirm_review：三项列全；尺码待人工确认与默认数量有专属话术', () => {
  const full = renderAction({
    kind: 'confirm_review',
    productText: '黑色双排扣西装',
    startDate: '2026-7-10',
    endDate: '2026-7-12',
    size: 'L',
    quantity: 2,
  })
  assert.match(full, /商品是"黑色双排扣西装"/)
  assert.match(full, /档期是 2026-7-10 到 2026-7-12/)
  assert.match(full, /尺码按 L 码/)
  assert.match(full, /数量 2 件/)

  const manual = renderAction({
    kind: 'confirm_review',
    size: '尺码待人工确认',
    quantityIsDefault: true,
  })
  assert.match(manual, /尺码我这边人工再帮您核对一次/)
  assert.match(manual, /数量按默认 1 件（要多件麻烦说一声）/)
  assert.match(manual, /商品信息，档期信息/)
  assert.match(renderAction({ kind: 'confirm_review' }), /尺码稍后复核/)
})

test('guide_order：多件 + 价格拼进引导语；信息不足时用泛称', () => {
  const full = renderAction({
    kind: 'guide_order',
    size: 'L',
    startDate: '2026-7-10',
    endDate: '2026-7-12',
    dailyPrice: 199,
    quantity: 2,
  })
  assert.match(full, /L 码更合适/)
  assert.match(full, /数量 2 件，首日 199 元，/)
  assert.match(full, /租赁时间按 2026-7-10 到 2026-7-12 填就可以/)
  const bare = renderAction({ kind: 'guide_order' })
  assert.match(bare, /合适尺码更合适，您要的档期这个时间也能安排/)
  assert.ok(!bare.includes('首日'))
})

// ---------- 开放通道 ----------

test('answer_faq：无 follow 原样输出；follow 语义重复时去重；否则空行拼接', () => {
  assert.equal(renderAction({ kind: 'answer_faq', text: ' 门店电话是 400。 ' }), '门店电话是 400。')
  assert.equal(
    renderAction({
      kind: 'answer_faq',
      text: '您把档期发我，我帮您排。',
      orchestrationFollowUp: '您把档期发我',
    }),
    '您把档期发我，我帮您排。',
  )
  assert.equal(
    renderAction({
      kind: 'answer_faq',
      text: '门店电话是 400。',
      orchestrationFollowUp: '您把档期发我。',
    }),
    '门店电话是 400。\n\n您把档期发我。',
  )
})

test('small_talk / handoff：passthrough 并 trim', () => {
  assert.equal(renderAction({ kind: 'small_talk', text: ' 哈哈好的～ ' }), '哈哈好的～')
  assert.equal(
    renderAction({ kind: 'handoff', text: ' 我请店长来跟您确认。 ', reason: '投诉' }),
    '我请店长来跟您确认。',
  )
})

// ---------- 辅助判断 ----------

test('isOrderActionKind：下单相关三个 kind 为 true，其余为 false', () => {
  assert.equal(isOrderActionKind('guide_order'), true)
  assert.equal(isOrderActionKind('confirm_review'), true)
  assert.equal(isOrderActionKind('check_availability'), true)
  assert.equal(isOrderActionKind('greet'), false)
  assert.equal(isOrderActionKind('answer_faq'), false)
})
