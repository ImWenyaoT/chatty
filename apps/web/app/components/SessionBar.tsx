'use client'

// 顶栏（64px）：品牌字标、可编辑的会话上下文（商品 / 客户），以及一枚
// Geist 风格 status pill（8px 圆点 + label-13），实时反映 loop 的会话状态。

const STATUS_LABEL: Record<string, string> = {
  active: '在线',
  waiting_for_user: '等待回复',
  waiting_for_tool: '处理中',
  waiting_for_human: '已转人工',
  paused: '已暂停',
  closed: '已结束',
  failed: '异常',
}

/** 把 loop 会话状态映射为 status pill 的色调（green/amber/blue/red/gray）。 */
function toneFor(status: string): string {
  if (status === 'active') return 'active'
  if (status === 'waiting_for_human') return 'human'
  if (status === 'failed') return 'error'
  if (status === 'waiting_for_user' || status === 'waiting_for_tool' || status === 'paused') {
    return 'wait'
  }
  return 'closed'
}

type Props = {
  status: string
  productId: string
  customerId: string
  disabled: boolean
  onProductId: (v: string) => void
  onCustomerId: (v: string) => void
}

/** SessionBar：三段式布局的第一段，承载会话级信息与上下文输入。 */
export function SessionBar({
  status,
  productId,
  customerId,
  disabled,
  onProductId,
  onCustomerId,
}: Props) {
  return (
    <header className="bar">
      <div className="brand">
        <span className="brand-mark">Chatty</span>
        <span className="brand-tag">租衣客服 playground</span>
      </div>

      <div className="bar-controls">
        <label className="field">
          <span className="field-k">商品</span>
          <input
            value={productId}
            onChange={(e) => onProductId(e.target.value)}
            disabled={disabled}
            spellCheck={false}
            aria-label="商品 ID"
          />
        </label>
        <label className="field">
          <span className="field-k">客户</span>
          <input
            className="wide"
            value={customerId}
            onChange={(e) => onCustomerId(e.target.value)}
            disabled={disabled}
            spellCheck={false}
            aria-label="客户 ID"
          />
        </label>
        <span className="status-pill" data-tone={toneFor(status)} role="status">
          <span className="dot" aria-hidden="true" />
          {STATUS_LABEL[status] ?? status}
        </span>
      </div>
    </header>
  )
}
