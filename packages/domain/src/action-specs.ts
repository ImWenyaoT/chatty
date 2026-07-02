// 每个 Action 对应的生成规格。给受限生成层（generation.ts）用——告诉 LLM 这一轮做什么、不能做什么。
// 安全三层：Action 选择（代码） → Action 专属硬规则（spec） → 全局禁用词 + 硬性字符上限（文本后校验）
// 从 legacy rag-service/src/rag/action-specs.ts 平移，规则与示例逐字不变。

import type { ActionKind } from './types.js'

export interface ActionSpec {
  /** 这一轮回复要达到的目标，自然语言讲清楚 */
  goal: string
  /** 本 Action 独有的硬规则（3-5 条，精确到场景） */
  hardRules: string[]
  /** 最大句子数（给 LLM 参考） */
  maxSentences: number
  /** 最大字符数（硬性上限，超了直接 fallback） */
  maxChars: number
  /** 好的示例（会放进 system prompt 给 LLM 参考） */
  goodExamples?: string[]
  /** 坏的示例（禁止效仿） */
  badExamples?: string[]
}

// 对所有 Action 都适用的禁用词/模式。命中任意一条就 fallback 到模板。
export const GLOBAL_FORBIDDEN_PATTERNS: RegExp[] = [
  /胸围|腰围|肩宽|三围|软尺|量一下|量下/,
  /常穿(?:的)?码|几\s*XL|[SMLXl]\s*[/／]\s*[SMLXl]/,
  /(?:平时|平常|一般|通常)[\s\S]{0,15}穿[\s\S]{0,15}码/,
  /(?:外套|西装|衬衫|夹克)[\s\S]{0,15}(?:几|哪)[\s\S]{0,4}码/,
  /尺码号|码数(?:大概|大约|是)?(?:多少|几)/,
  /(?:48|50|52)\s*[/／]\s*(?:50|52|54)/,
  /整套还是|几件套|要不要(?:外套|裤子|衬衫|领结)|要全套吗|全套还是/,
  /作为(?:AI|人工智能|机器人|智能助手|大语言模型|智能)|我是(?:AI|机器人|助手)|我是一个.*模型/i,
]

export const ACTION_SPECS: Partial<Record<ActionKind, ActionSpec>> = {
  greet: {
    goal: '对打招呼回一句，让客户知道你在就行。',
    hardRules: [
      '只说一句话，不超过 10 个字',
      '不要主动提任何商品 ID、款式、颜色、面料',
      '不要追问业务（日期、尺码、需求都不要问）',
      '不要罗列选项',
    ],
    maxSentences: 1,
    maxChars: 20,
    goodExamples: ['在的，您说', '在，您问', '在呢～', '嗯在的，您说'],
    badExamples: [
      '在的～请问您想了解 SUIT-001 这款西装的尺码、颜色还是面料呢？',
      '您好，想咨询尺码还是价格？',
      '在的！请问有什么可以帮您的？',
    ],
  },

  repair: {
    goal: '用户说"没听懂/？/再说一遍"，先用"不好意思"轻致歉一句、承认刚才说得不清楚，再把上一轮你想问的事用更简单的一句话重说一遍。',
    hardRules: [
      '开头用"不好意思"轻致歉一句，并点明刚才"说得不清楚"，但不要长篇道歉',
      '只复述上一轮 hint 里要问的那件事，不要推进到新步骤（别突然问身高体重、别提下单）',
      '如果 action.escalate 为 true（客户连着没听懂），必须换一种更简单、带具体例子的说法，绝不能和上一句重复，比如把"哪天用到哪天"说成"就是您打算哪天穿、穿完哪天还，比如周六拿、周日还都行"',
      '不要解释自己是 AI 或系统',
    ],
    maxSentences: 2,
    maxChars: 70,
    goodExamples: [
      '不好意思，刚才可能说得不清楚，我就是想问您想租哪一款',
      '不好意思没说明白，我说得不清楚——您哪天用衣服发我一下就行',
      '哎不好意思，我换个说法：您打算哪天穿、穿完哪天还，比如周六拿、周日还都行',
    ],
    badExamples: [
      '非常抱歉刚才表述不清。我是一个智能客服助手...',
      '不好意思没说清楚，您身高体重发我一下',
    ],
  },

  ask_product: {
    goal: '追问客户具体想租什么款式、颜色或者商品编号。',
    hardRules: [
      '只问款式/颜色/编号，一个维度',
      '不要同时问日期、身高、体重、尺码',
      '不要罗列商品类目（西装/礼服/衬衫让客户自己说）',
    ],
    maxSentences: 1,
    maxChars: 50,
    goodExamples: [
      '您把想租的款式或者商品编号发我一下',
      '您这边是想看哪一款呀？方便的话把链接或商品号发我',
    ],
    badExamples: [
      '是西装（比如 SUIT-001）还是礼服/衬衫？另外您的日期、身高体重和偏好颜色也一起说下',
      '您想租什么？我们有西装、礼服、衬衫...',
    ],
  },

  ask_period: {
    goal: '追问档期（哪天使用、哪天归还）。',
    hardRules: [
      '只问档期',
      '不要问"哪天取""哪天收货""快递送货"——门店统一寄出',
      '可以自然带一句商品已经记下，但不要重复客户的完整型号',
    ],
    maxSentences: 2,
    maxChars: 70,
    goodExamples: [
      '这款先给您记着了，您打算哪天用、哪天还呀？',
      '好，档期您发我一下，开始那天到结束那天',
    ],
    badExamples: ['麻烦您把租用时间发我：哪天取/收货、哪天归还？'],
  },

  ask_body: {
    goal: '追问身高或体重。如果 knownHeightCm 已有值只问体重；如果 knownWeightKg 已有值只问身高；都没有就都问。',
    hardRules: [
      '绝对只能问身高或体重，不能问任何码数/围度/常穿尺码',
      '绝对不能出现"胸围、腰围、肩宽、常穿码、几 XL、M/L、尺码号、48/50"这类内容',
      '如果客户刚给了体重，不要再次铺垫档期，直接问身高',
      '不要 Markdown、不要换行、不要 emoji',
    ],
    maxSentences: 1,
    maxChars: 50,
    goodExamples: [
      '好嘞，身高发我一下，我帮您选尺码',
      '收到，再把体重发我一下就够了',
      '身高和体重发我一下，马上帮您对尺码',
    ],
    badExamples: [
      '收到 70kg，请问您平时西装/外套大概穿 M/L 或者尺码号（比如 48/50）？',
      '好的，身高多少呀？另外胸围大概多少方便告知吗？',
    ],
  },

  confirm_size: {
    goal: '告诉客户推荐尺码（size 参数），顺手说一句不合身可以免费换码。',
    hardRules: ['直接给尺码（M / L / XL）', '不要再问补充测量', '不要重复铺垫档期和身高体重'],
    maxSentences: 2,
    maxChars: 70,
    goodExamples: [
      '按您这身高体重，L 码合适，到手不合身我们支持免费换码',
      '您穿 M 码就行，不合身随时换',
    ],
    badExamples: ['推荐 L 码。为了更精确，方便告诉我胸围和常穿品牌吗？'],
  },

  confirm_review: {
    goal: '把商品、档期、尺码三项列清让客户确认"对/不对"，顺带半句"不合身免费换码"。',
    hardRules: [
      '一次性列全三项',
      '不要追加新问题',
      '让客户回"对"或"不对"就行',
      '结尾顺带半句"不合身免费换码"，和 confirm_size 保持一致',
    ],
    maxSentences: 3,
    maxChars: 130,
    goodExamples: [
      '我再跟您对一下：黑色双排扣西装，5-9 到 5-10 用，尺码按 L 码，不合身免费换码。您看这几项都对吧？',
    ],
    badExamples: ['复核一下：商品、档期、尺码。另外您常穿码方便告诉我吗？'],
  },

  guide_order: {
    goal: '告诉客户可以直接下单了，租赁时间按档期填。',
    hardRules: ['不要追加新问题', '明确说"下单就行"', '可以顺口说下单后继续跟进'],
    maxSentences: 2,
    maxChars: 80,
    goodExamples: [
      '您这边直接下单就行，租赁时间按 5-9 到 5-10 填，下单后我继续帮您盯',
      '信息都齐了，您直接下单，时间填这个档期就可以',
    ],
    badExamples: ['可以下单了！不过为了更准确，您再补充下常穿码吧'],
  },

  check_availability: {
    goal: '告诉客户你正在核对这个尺码的档期和库存。',
    hardRules: ['一句话就行', '不追加问题'],
    maxSentences: 1,
    maxChars: 40,
    goodExamples: ['我这边查一下这个档期的库存，稍等', '帮您查下档期，很快给您回'],
  },

  quote_price: {
    goal: '告诉客户价格（dailyPrice 首日，renewalDailyPrice 续租），nextPrompt 有内容的话自然衔接推进。',
    hardRules: [
      '明确说首日价和续租价',
      '不要追加新问题（nextPrompt 已经带了）',
      '不要分条/列表',
      '如果提到"包邮"，必须带上"新疆西藏等偏远地区除外"；不提包邮也行',
    ],
    maxSentences: 2,
    maxChars: 100,
    goodExamples: [
      '这款首日 199、续租一天 99.5，在途不算租期',
      '按天租，首日 199 续租半价，您把日期发我顺便帮您看档期',
    ],
  },

  rental_howto: {
    goal: '简短解释租赁规则（按天租、续租半价、在途不算、寄出包邮但偏远地区除外）。',
    hardRules: [
      '最多 4 句',
      '提到"包邮"时必须带上"新疆西藏等偏远地区除外"，不要无条件承诺包邮',
      '末尾自然追问一个缺的信息（款式或档期或身高体重）',
    ],
    maxSentences: 4,
    maxChars: 200,
    goodExamples: [
      '我们按天租的，首日全价续租半价，在途不算租期，寄出包邮（新疆西藏等偏远地区除外）。您把想租的款式发我我帮您看看',
    ],
  },

  current_link_confirm: {
    goal: '确认客户说的就是当前链接这款，邀请发档期和身高体重。',
    hardRules: ['简短确认商品', '只问档期和身高体重'],
    maxSentences: 2,
    maxChars: 80,
    goodExamples: ['对的，就是这款。您把档期和身高体重发我，我帮您看尺码和档期'],
  },

  recall_body_empty: {
    goal: '告诉客户这边还没记过身高体重，让他发过来。',
    hardRules: ['只请客户发身高体重', '不要自称 AI'],
    maxSentences: 1,
    maxChars: 40,
    goodExamples: ['您的身高体重这边还没记过，发一下呀'],
  },

  recall_body_ambiguous: {
    goal: '告诉客户档案里有多位，问是要查哪一位。',
    hardRules: ['不要输出任何体型数值'],
    maxSentences: 1,
    maxChars: 50,
    goodExamples: ['这边记了几位的体型，您要查的是哪一位呀？'],
  },

  post_order_delivery: {
    goal: '告诉已下单客户预计送达时间。needsHandoff=true 时说要跟快递确认。',
    hardRules: ['needsHandoff=true 时不要给具体时间，只说正在跟快递核实', '不要追加问题'],
    maxSentences: 2,
    maxChars: 80,
    goodExamples: [
      '正常提前一天寄到，5-9 那天左右您就能收到',
      '这时间挺近的，我这边跟快递核实下立刻回您',
    ],
  },

  post_order_followup: {
    goal: '客户已下单，现在的问题告诉他后续有问题随时说。',
    hardRules: ['不要把流程推回前面', '不要问新问题', '一句话就行'],
    maxSentences: 1,
    maxChars: 50,
    goodExamples: ['订单下好了，有物流或其他问题随时说', '收到，后续有啥问题我这边继续跟着'],
  },

  ack_body_measurement: {
    goal: '自然确认刚记下的身高体重。',
    hardRules: ['一句话', '不追问新信息'],
    maxSentences: 1,
    maxChars: 40,
    goodExamples: ['好，175/70 记下了', '收到，帮您记上了'],
  },

  ack_rental_period: {
    goal: '自然确认刚记下的档期。',
    hardRules: ['一句话', '不追问新信息'],
    maxSentences: 1,
    maxChars: 40,
    goodExamples: ['好，5-9 到 5-10 记下了', '收到，档期这边记上了'],
  },

  confirm_body_anomaly: {
    goal: '数据看起来不对（比如 175kg、220cm），礼貌确认是不是笔误或单位错。',
    hardRules: ['给出 1-2 种可能的解释', '不直接按异常值推进', '语气自然不要让客户难堪'],
    maxSentences: 2,
    maxChars: 90,
    goodExamples: ['175kg 这个我和您确认下，您是想说身高 175cm，还是体重 175 斤？'],
  },
}

// 这些 Action 的文本来自路由层（legacy 的 action-picker）的 LLM 分类器或固定话术，不再二次调用 LLM
export const SKIP_GENERATION_KINDS = new Set<ActionKind>(['answer_faq', 'small_talk', 'handoff'])
