'use client'

// Top bar: brand wordmark, a live session-status chip, and the editable
// conversation context (product / customer) so the playground can drive any
// product without code changes.

const STATUS_LABEL: Record<string, string> = {
  active: '在线',
  waiting_for_user: '等待回复',
  waiting_for_tool: '处理中',
  waiting_for_human: '已转人工',
  paused: '已暂停',
  closed: '已结束',
  failed: '异常',
}

/** Maps a loop session status onto a chip colour tone. */
function toneFor(status: string): string {
  if (status === 'waiting_for_human') return 'human'
  if (status === 'active') return 'active'
  if (status === 'waiting_for_user' || status === 'waiting_for_tool' || status === 'paused') {
    return 'wait'
  }
  return 'idle'
}

type Props = {
  status: string
  productId: string
  customerId: string
  disabled: boolean
  onProductId: (v: string) => void
  onCustomerId: (v: string) => void
}

export function SessionBar({
  status,
  productId,
  customerId,
  disabled,
  onProductId,
  onCustomerId,
}: Props) {
  return (
    <>
      <header className="bar">
        <div className="brand">
          <span className="mark">
            Chat<em>ty</em>
          </span>
          <span className="tag">租衣客服</span>
        </div>
        <span className="status" data-tone={toneFor(status)}>
          <span className="dot" />
          {STATUS_LABEL[status] ?? status}
        </span>
      </header>

      <div className="context">
        <label>
          <span className="k">商品</span>
          <input
            value={productId}
            onChange={(e) => onProductId(e.target.value)}
            disabled={disabled}
            spellCheck={false}
            aria-label="商品 ID"
          />
        </label>
        <label>
          <span className="k">客户</span>
          <input
            className="wide"
            value={customerId}
            onChange={(e) => onCustomerId(e.target.value)}
            disabled={disabled}
            spellCheck={false}
            aria-label="客户 ID"
          />
        </label>
      </div>
    </>
  )
}
