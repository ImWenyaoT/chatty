export type SellerOrder = {
  id: string
  customer: string
  product: string
  period: string
  size: string
  amount: string
  status: '待复核' | '待发货' | '租赁中' | '待归还'
  channel: string
  updatedAt: string
  risk: string
  address: string
  notes: string[]
  timeline: Array<{ time: string; event: string }>
}

export const SELLER_ORDERS: SellerOrder[] = [
  {
    id: 'ORDER-TEST-1001',
    customer: 'playground-customer',
    product: '黑色三件套西装',
    period: '2026-05-10 至 2026-05-12',
    size: 'L · 待最终复核',
    amount: '¥760',
    status: '待复核',
    channel: '小红书私信',
    updatedAt: '刚刚',
    risk: '尺码需要客服确认',
    address: '上海市静安区 · 待客户补全门牌',
    notes: ['客户 180cm / 70kg', '希望婚礼前一天送达', '已确认首日 ¥380，续租半价'],
    timeline: [
      { time: '09:34', event: '客户补齐身高体重' },
      { time: '09:36', event: 'Chatty 给出 L 码建议' },
      { time: '09:41', event: '卖家手动录入订单号' },
    ],
  },
  {
    id: 'ORD-20260703-018',
    customer: 'cx-042',
    product: '白色缎面礼服',
    period: '2026-07-18 至 2026-07-20',
    size: 'M',
    amount: '¥1,180',
    status: '待发货',
    channel: '微信',
    updatedAt: '12m ago',
    risk: '无',
    address: '杭州市西湖区',
    notes: ['已完成押金确认', '客户要求顺丰保价'],
    timeline: [
      { time: '10:02', event: '订单创建' },
      { time: '10:08', event: '人工复核通过' },
      { time: '10:15', event: '等待仓库打包' },
    ],
  },
  {
    id: 'ORD-20260703-006',
    customer: 'cx-017',
    product: '深蓝商务西装',
    period: '2026-07-05 至 2026-07-06',
    size: 'XL',
    amount: '¥520',
    status: '租赁中',
    channel: '淘宝',
    updatedAt: '1h ago',
    risk: '明日归还提醒',
    address: '北京市朝阳区',
    notes: ['已签收', '需要明天上午提醒归还'],
    timeline: [
      { time: '昨天 15:20', event: '仓库发货' },
      { time: '今天 09:30', event: '客户签收' },
      { time: '今天 11:05', event: 'Chatty 安排归还提醒' },
    ],
  },
]

/** Returns the seeded order currently used by the seller dashboard pages. */
export function getPrimaryOrder() {
  return SELLER_ORDERS[0]
}
