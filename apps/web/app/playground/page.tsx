'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { SellerNavigation } from '../components/seller/SellerNavigation'
import { SELLER_ORDERS, type SellerOrder } from '../components/seller/orderData'
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
}

type SessionProfile = {
  productText: string
  bodyText: string
  rentalText: string
  priceText: string
  sizeText: string
  orderNo: string
  reviewText: string
  readyText: string
  stage: string
  nextAction: string
  goal: string
}

type KnowledgeHit = {
  label: string
  content: string
}

const DEFAULT_PROFILE: SessionProfile = {
  productText: '黑色三件套西装',
  bodyText: '180cm / 70kg',
  rentalText: '2026-05-10 到 2026-05-12',
  priceText: '首日 ¥380 · 续租半价',
  sizeText: 'L · 待最终复核',
  orderNo: '未录单',
  reviewText: '待复核',
  readyText: '还差一步',
  stage: 'intent_discovery',
  nextAction: '等待客户消息',
  goal: '先把客户需求补齐，再往下推进',
}

const PRODUCT_ID_BY_ORDER_ID: Record<string, string> = {
  'ORDER-TEST-1001': 'SUIT-001',
  'ORD-20260703-018': 'DRESS-001',
  'ORD-20260703-006': 'SUIT-002',
}

/** Maps a harness task into seller-facing workflow stage language. */
function stageFromTrace(
  trace?: HarnessTrace,
): Pick<SessionProfile, 'stage' | 'nextAction' | 'goal'> {
  const task = trace?.task?.kind
  if (task === 'check_availability') {
    return {
      stage: 'availability_checking',
      nextAction: '检查档期和库存',
      goal: trace?.task?.goal ?? '检查档期和尺码库存',
    }
  }
  if (task === 'handoff') {
    return {
      stage: 'human_handoff',
      nextAction: '转人工处理',
      goal: trace?.task?.goal ?? '转人工继续处理',
    }
  }
  if (task === 'follow_up') {
    return {
      stage: 'post_order_followup',
      nextAction: '安排后续跟进',
      goal: trace?.task?.goal ?? '安排后续跟进',
    }
  }
  if (task === 'collect_missing_info') {
    return {
      stage: 'slot_collecting',
      nextAction: '补齐关键信息',
      goal: trace?.task?.goal ?? '补齐商品、档期、体型或数量',
    }
  }
  return {
    stage: 'intent_discovery',
    nextAction: trace?.action?.action ?? '回答客户问题',
    goal: trace?.task?.goal ?? '识别客户意图并回复',
  }
}

/** Converts the latest trace and selected order into the customer context board. */
function profileFromTrace(trace: HarnessTrace | undefined, order: SellerOrder): SessionProfile {
  const stage = stageFromTrace(trace)
  const task = trace?.task?.kind
  return {
    ...DEFAULT_PROFILE,
    ...stage,
    productText: order.product,
    rentalText: order.period,
    sizeText: order.size,
    orderNo: order.id,
    reviewText: order.risk === '无' ? '无需额外复核' : order.risk,
    readyText: task === 'check_availability' ? '可继续复核' : order.status,
  }
}

/** Formats a compact status label for the stage ribbon chips. */
function chipTone(done: boolean): string {
  return done ? 'ok' : 'pending'
}

/** Builds seller-readable knowledge hits from the same fragments used by the harness. */
function knowledgeHitsFromTrace(trace?: HarnessTrace): KnowledgeHit[] {
  return (trace?.context?.fragments ?? [])
    .map((fragment) => ({
      label: fragment.label ?? fragment.kind ?? '知识片段',
      content: fragment.content ?? '',
    }))
    .filter((hit) => hit.content.trim().length > 0)
    .slice(0, 4)
}

/** Summarises visible conversation turns into recent customer context. */
function recentSellerMessages(turns: ChatTurn[]): Array<{ role: string; content: string }> {
  return turns
    .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
    .slice(-6)
    .map((turn) => ({
      role: turn.role === 'user' ? '用户' : '智能客服',
      content: turn.content,
    }))
}

/** Renders the seller-facing customer service workspace. */
export default function CustomerServicePage() {
  const [selectedOrderId, setSelectedOrderId] = useState(SELLER_ORDERS[0].id)
  const [question, setQuestion] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [status, setStatus] = useState('等待客户消息')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const nextId = useRef(1)
  const bottomRef = useRef<HTMLDivElement>(null)

  const selectedOrder =
    SELLER_ORDERS.find((order) => order.id === selectedOrderId) ?? SELLER_ORDERS[0]
  const productId = PRODUCT_ID_BY_ORDER_ID[selectedOrder.id] ?? 'SUIT-001'
  const conversationId = `${selectedOrder.customer}:${productId}`
  const latestAgent = [...turns].reverse().find((turn) => turn.role === 'assistant')
  const profile = useMemo(
    () => profileFromTrace(latestAgent?.trace, selectedOrder),
    [latestAgent?.trace, selectedOrder],
  )
  const knowledgeHits = useMemo(
    () => knowledgeHitsFromTrace(latestAgent?.trace),
    [latestAgent?.trace],
  )
  const recentMessages = useMemo(() => recentSellerMessages(turns), [turns])

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
    <div className="legacy-console">
      <SellerNavigation active="playground" />
      <header className="legacy-hero">
        <div>
          <p>CUSTOMER SERVICE</p>
          <h1>客服会话</h1>
          <span>处理当前客户咨询、查看客户上下文、推进下一步动作。</span>
        </div>
        <div className="legacy-hud" aria-live="polite" role="status">
          <span>{selectedOrder.channel}</span>
          <span>{status}</span>
        </div>
      </header>

      <div className={`legacy-shell support-inbox-shell ${detailsOpen ? 'details-open' : ''}`}>
        <aside className="legacy-sidebar">
          <section>
            <h2>客户队列</h2>
            <div className="legacy-conversation-list">
              {SELLER_ORDERS.map((order) => (
                <button
                  aria-pressed={order.id === selectedOrder.id}
                  data-active={order.id === selectedOrder.id}
                  key={order.id}
                  type="button"
                  onClick={() => selectOrder(order.id)}
                >
                  <span>{order.channel}</span>
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
                {selectedOrder.customer} · {selectedOrder.product}
              </p>
            </div>
            <div>
              <button type="button" onClick={() => setTurns([])}>
                清空会话
              </button>
              <button
                aria-expanded={detailsOpen}
                type="button"
                onClick={() => setDetailsOpen((open) => !open)}
              >
                客户详情
              </button>
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
            <label className="legacy-image-url">
              客户图片，可选
              <input
                value={imageUrl}
                placeholder="粘贴客户发来的图片链接"
                onChange={(event) => setImageUrl(event.target.value)}
              />
            </label>
            <form
              aria-label="发送客户消息"
              onSubmit={(event) => {
                event.preventDefault()
                sendMessage(question)
              }}
            >
              <textarea
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
              <button type="submit" disabled={(!question.trim() && !imageUrl.trim()) || sending}>
                发送
              </button>
            </form>
          </div>
        </main>

        {detailsOpen ? (
          <aside className="support-detail-panel" aria-label="客户详情">
            <section>
              <h2>客户上下文</h2>
              <StageRibbon profile={profile} />
              <SellerMemoryPanel
                profile={profile}
                recentMessages={recentMessages}
                selectedOrder={selectedOrder}
              />
            </section>

            <section>
              <h2>订单待办</h2>
              <div className="legacy-task-list">
                <div>
                  <strong>当前状态</strong>
                  <span>{selectedOrder.status}</span>
                </div>
                <div>
                  <strong>风险点</strong>
                  <span>{selectedOrder.risk}</span>
                </div>
                <div>
                  <strong>下一步</strong>
                  <span>{selectedOrder.automation.nextStep}</span>
                </div>
              </div>
            </section>

            <section>
              <h2>知识命中</h2>
              <KnowledgeHitList hits={knowledgeHits} />
            </section>
          </aside>
        ) : null}
      </div>
    </div>
  )
}

/** Renders the customer profile cards used by the service workspace. */
function SessionProfileBoard({ profile }: { profile: SessionProfile }) {
  return (
    <div className="legacy-profile-board">
      {[
        ['意向商品', profile.productText],
        ['客户体型', profile.bodyText],
        ['租赁档期', profile.rentalText],
        ['报价信息', profile.priceText],
        ['推荐尺码', profile.sizeText],
        ['订单状态', profile.orderNo],
        ['复核状态', profile.reviewText],
        ['下单状态', profile.readyText],
      ].map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  )
}

/** Renders the current workflow stage and missing order slots. */
function StageRibbon({ profile }: { profile: SessionProfile }) {
  const steps = [
    ['商品', true],
    ['档期', profile.stage === 'availability_checking' || profile.orderNo !== '未录单'],
    ['体型', true],
    ['尺码', profile.stage === 'availability_checking' || profile.orderNo !== '未录单'],
    ['复核', profile.reviewText !== '待复核'],
    ['下单', profile.orderNo !== '未录单'],
  ] as const

  return (
    <div className="legacy-stage-ribbon">
      <div>
        <span>阶段 · {profile.stage}</span>
        <strong>{profile.goal}</strong>
        <p>下一动作：{profile.nextAction}</p>
      </div>
      <div className="legacy-stage-steps">
        {steps.map(([label, done]) => (
          <span data-tone={chipTone(done)} key={label}>
            {label}
          </span>
        ))}
      </div>
      <div className="legacy-flow-grid">
        <div>
          <span>已掌握</span>
          <strong>商品 / 档期 / 客户体型</strong>
        </div>
        <div>
          <span>待推进</span>
          <strong>{profile.reviewText === '无需额外复核' ? '发货跟进' : profile.reviewText}</strong>
        </div>
        <div>
          <span>订单</span>
          <strong>{profile.orderNo}</strong>
        </div>
      </div>
    </div>
  )
}

/** Renders seller-facing memory cards from order context and recent turns. */
function SellerMemoryPanel({
  profile,
  recentMessages,
  selectedOrder,
}: {
  profile: SessionProfile
  recentMessages: Array<{ role: string; content: string }>
  selectedOrder: SellerOrder
}) {
  return (
    <div className="legacy-memory-sections">
      <div>
        <span>客户摘要</span>
        <p>
          {selectedOrder.customer} · {selectedOrder.product} · {selectedOrder.period}
        </p>
      </div>
      <div>
        <span>关键事实</span>
        <SessionProfileBoard profile={profile} />
      </div>
      <div>
        <span>最近对话</span>
        {recentMessages.length > 0 ? (
          recentMessages.map((message, index) => (
            <p key={`${message.role}-${index}`}>
              {message.role}: {message.content}
            </p>
          ))
        ) : (
          <p>暂无消息记录</p>
        )}
      </div>
    </div>
  )
}

/** Shows knowledge/reference hits as business evidence instead of developer context. */
function KnowledgeHitList({ hits }: { hits: KnowledgeHit[] }) {
  if (hits.length === 0) {
    return <p className="legacy-muted">本轮回复引用的商品、规则或历史问答会显示在这里。</p>
  }
  return (
    <div className="legacy-knowledge-list">
      {hits.map((hit, index) => (
        <article key={`${hit.label}-${index}`}>
          <strong>{hit.label}</strong>
          <p>{hit.content}</p>
        </article>
      ))}
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
