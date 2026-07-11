'use client'

import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Send } from 'lucide-react'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { SellerNavigation } from '../components/seller/SellerNavigation'
import { SELLER_ORDERS } from '../components/seller/orderData'
import type { HarnessTrace, PlaygroundResponse } from '../components/types'

type ChatTurn = {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  trace?: HarnessTrace
  traceId?: string
  sessionId?: string
  terminality?: string
  status?: string
  runId?: string
}

type ControlPlaneView = {
  workflowEvents: Array<{ sequence: number; type: string; payload: unknown }>
  checkpoint?: { version: number; tokenBefore: number; tokenAfter: number; summary: unknown }
  memories: Array<{ id: string; category: string; key: string; status: string; usageCount: number }>
}

const PRODUCT_ID_BY_ORDER_ID: Record<string, string> = {
  'ORDER-TEST-1001': 'SUIT-001',
  'ORD-20260703-018': 'DRESS-001',
  'ORD-20260703-006': 'SUIT-002',
}

/** Renders the seller-facing customer service workspace. */
export default function CustomerServicePage() {
  const [selectedOrderId, setSelectedOrderId] = useState(SELLER_ORDERS[0].id)
  const [question, setQuestion] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [status, setStatus] = useState('等待客户消息')
  const [sending, setSending] = useState(false)
  const [controlPlane, setControlPlane] = useState<ControlPlaneView>()
  const nextId = useRef(1)
  const bottomRef = useRef<HTMLDivElement>(null)

  const selectedOrder =
    SELLER_ORDERS.find((order) => order.id === selectedOrderId) ?? SELLER_ORDERS[0]
  const productId = PRODUCT_ID_BY_ORDER_ID[selectedOrder.id] ?? 'SUIT-001'
  const conversationId = `${selectedOrder.customer}:${productId}`

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [turns, sending])

  /** Selects a customer queue item and clears the transient conversation view. */
  function selectOrder(orderId: string) {
    setSelectedOrderId(orderId)
    setTurns([])
    setQuestion('')
    setImageUrl('')
    setStatus('等待客户消息')
  }

  /** Sends a customer message through the harness using product-safe defaults. */
  async function sendMessage(text: string) {
    const trimmed = text.trim()
    const attachedImageUrl = imageUrl.trim()
    if ((!trimmed && !attachedImageUrl) || sending) return

    const visibleContent = attachedImageUrl
      ? `${trimmed || '发送了一张图片'}\n图片：${attachedImageUrl}`
      : trimmed
    setTurns((prev) => [...prev, { id: nextId.current++, role: 'user', content: visibleContent }])
    setQuestion('')
    setImageUrl('')
    setSending(true)
    setStatus('Chatty 正在处理客户消息')

    try {
      const response = await fetch('/api/playground', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId: selectedOrder.customer,
          productId,
          conversationId,
          question: trimmed,
          imageUrl: attachedImageUrl || undefined,
          sessionContext: {
            channel: selectedOrder.channel,
            sellerMode: true,
          },
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.error ?? '请求失败')

      const reply = data as PlaygroundResponse
      const controlResponse = await fetch(
        `/api/control-plane?conversationId=${encodeURIComponent(conversationId)}&customerId=${encodeURIComponent(selectedOrder.customer)}&runId=${encodeURIComponent(reply.runId)}`,
      )
      if (controlResponse.ok) setControlPlane((await controlResponse.json()) as ControlPlaneView)
      setTurns((prev) => [
        ...prev,
        {
          id: nextId.current++,
          role: 'assistant',
          content: reply.reply || '（无回复）',
          trace: reply.harnessTrace,
          traceId: reply.traceId,
          sessionId: reply.sessionId,
          terminality: reply.terminality,
          status: reply.status,
          runId: reply.runId,
        },
      ])
      setStatus(reply.terminality === 'terminal' ? '本轮已完成' : '等待继续跟进')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setTurns((prev) => [
        ...prev,
        { id: nextId.current++, role: 'system', content: `请求失败：${message}` },
      ])
      setStatus(`请求失败：${message}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="legacy-console support-console">
      <SellerNavigation active="playground" />
      <div className="legacy-shell support-inbox-shell">
        <aside className="legacy-sidebar">
          <section>
            <div className="support-sidebar-head">
              <div>
                <span>CUSTOMER SERVICE</span>
                <h2>客户队列</h2>
              </div>
              <Badge>{SELLER_ORDERS.length}</Badge>
            </div>
            <div className="legacy-conversation-list">
              {SELLER_ORDERS.map((order) => (
                <button
                  aria-pressed={order.id === selectedOrder.id}
                  data-active={order.id === selectedOrder.id}
                  key={order.id}
                  type="button"
                  onClick={() => selectOrder(order.id)}
                >
                  <span>
                    {order.channel} · {order.updatedAt}
                  </span>
                  <strong>{order.customer}</strong>
                  <small>
                    {order.product} · {order.status}
                  </small>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <main className="legacy-main" id="main-content">
          <div className="legacy-chat-topbar">
            <div>
              <h2>实时会话</h2>
              <p>
                {selectedOrder.channel} · {selectedOrder.customer} · {selectedOrder.product}
              </p>
            </div>
            <div className="support-chat-actions">
              <div className="legacy-hud" aria-live="polite" role="status">
                <Badge variant={sending ? 'warning' : 'secondary'}>{status}</Badge>
              </div>
            </div>
          </div>

          <div
            aria-busy={sending}
            aria-label="实时会话记录"
            aria-live="polite"
            className="legacy-chat-history"
            role="log"
          >
            {turns.length === 0 ? (
              <div className="legacy-empty">
                当前客户尚未开始本轮会话。输入客户问题后，Chatty 会结合商品、档期和规则生成回复。
              </div>
            ) : (
              turns.map((turn) => <LegacyMessage key={turn.id} turn={turn} />)
            )}
            {sending ? <div className="legacy-typing">Chatty 正在处理...</div> : null}
            <div ref={bottomRef} />
          </div>

          <div className="legacy-composer">
            <div className="legacy-composer-meta">
              <span>客户消息</span>
              <span>{question.length} 字</span>
            </div>
            <form
              className="legacy-composer-box"
              aria-label="发送客户消息"
              onSubmit={(event) => {
                event.preventDefault()
                sendMessage(question)
              }}
            >
              <details className="legacy-attachment-details">
                <summary aria-label="添加客户图片">
                  <ImagePlus data-icon="inline-start" />
                </summary>
                <label className="legacy-image-url">
                  客户图片链接
                  <Input
                    value={imageUrl}
                    placeholder="粘贴客户发来的图片链接"
                    onChange={(event) => setImageUrl(event.target.value)}
                  />
                </label>
              </details>
              <Textarea
                aria-label="客户消息"
                value={question}
                placeholder="输入客户原话，例如：我身高180体重70，这款能穿吗？"
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    sendMessage(question)
                  }
                }}
              />
              <Button
                className="legacy-send-button"
                size="icon"
                type="submit"
                aria-label="发送"
                disabled={(!question.trim() && !imageUrl.trim()) || sending}
              >
                <Send data-icon="inline-start" />
              </Button>
            </form>
          </div>
          <section className="dashboard-panel" aria-label="Harness 控制面">
            <div className="dashboard-panel-head">
              <h2>Workflow 时间线</h2>
              <span>{controlPlane?.workflowEvents.length ?? 0} EVENTS</span>
            </div>
            <div className="dashboard-detail-grid">
              {(controlPlane?.workflowEvents ?? []).map((event) => (
                <div key={`${event.sequence}-${event.type}`}>
                  <span>#{event.sequence}</span>
                  <strong>{event.type}</strong>
                </div>
              ))}
            </div>
            <div className="dashboard-panel-head">
              <h2>Context / Memory</h2>
              <span>CHECKPOINT {controlPlane?.checkpoint?.version ?? 0}</span>
            </div>
            <p>
              压缩 tokens：{controlPlane?.checkpoint?.tokenBefore ?? 0} →{' '}
              {controlPlane?.checkpoint?.tokenAfter ?? 0}
            </p>
            <p>
              长期记忆：
              {(controlPlane?.memories ?? [])
                .map((memory) => `${memory.key} · ${memory.status} · used ${memory.usageCount}`)
                .join(' / ') || '暂无'}
            </p>
          </section>
        </main>
      </div>
    </div>
  )
}

/** Renders one chat message in the seller transcript style. */
function LegacyMessage({ turn }: { turn: ChatTurn }) {
  return (
    <article className={`legacy-message ${turn.role}`}>
      <div className="legacy-message-role">
        {turn.role === 'user' ? '用户' : turn.role === 'assistant' ? '客服' : '系统'}
      </div>
      <div className="legacy-message-content">{turn.content}</div>
      {turn.traceId ? (
        <p>
          状态：{turn.status} · 会话 {turn.sessionId}
        </p>
      ) : null}
    </article>
  )
}
