'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { SellerNavigation } from '../components/seller/SellerNavigation'
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

const PRESET_QUESTIONS = [
  '这件西装多少钱一天？',
  '黑色三件套西装 2026-05-10 到 2026-05-12 L 码有货吗？',
  '我身高180体重70，这款能穿吗？',
  '我要退款',
]

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

/** Maps a harness task into the old console's stage language. */
function stageFromTrace(
  trace?: HarnessTrace,
): Pick<SessionProfile, 'stage' | 'nextAction' | 'goal'> {
  const task = trace?.task?.kind
  if (task === 'check_availability') {
    return {
      stage: 'availability_checking',
      nextAction: 'check_availability',
      goal: trace?.task?.goal ?? '检查档期和尺码库存',
    }
  }
  if (task === 'handoff') {
    return {
      stage: 'human_handoff',
      nextAction: 'create_handoff',
      goal: trace?.task?.goal ?? '转人工继续处理',
    }
  }
  if (task === 'follow_up') {
    return {
      stage: 'post_order_followup',
      nextAction: 'schedule_followup',
      goal: trace?.task?.goal ?? '安排后续跟进',
    }
  }
  if (task === 'collect_missing_info') {
    return {
      stage: 'slot_collecting',
      nextAction: 'ask_missing_info',
      goal: trace?.task?.goal ?? '补齐商品、档期、体型或数量',
    }
  }
  return {
    stage: 'intent_discovery',
    nextAction: trace?.action?.action ?? 'answer_question',
    goal: trace?.task?.goal ?? '识别客户意图并回复',
  }
}

/** Converts the latest trace and manual order number into the legacy session profile board. */
function profileFromTrace(trace: HarnessTrace | undefined, orderNo: string): SessionProfile {
  const stage = stageFromTrace(trace)
  const task = trace?.task?.kind
  return {
    ...DEFAULT_PROFILE,
    ...stage,
    orderNo: orderNo || DEFAULT_PROFILE.orderNo,
    reviewText: orderNo ? '订单已接入，待发货复核' : DEFAULT_PROFILE.reviewText,
    readyText: task === 'check_availability' ? '可继续复核' : orderNo ? '已下单待跟进' : '还差一步',
  }
}

/** Formats a compact status label for the old stage ribbon chips. */
function chipTone(done: boolean): string {
  return done ? 'ok' : 'pending'
}

/** Builds seller-readable knowledge hits from the same fragments the old UI showed as references. */
function knowledgeHitsFromTrace(trace?: HarnessTrace): KnowledgeHit[] {
  return (trace?.context?.fragments ?? [])
    .map((fragment) => ({
      label: fragment.label ?? fragment.kind ?? '知识片段',
      content: fragment.content ?? '',
    }))
    .filter((hit) => hit.content.trim().length > 0)
    .slice(0, 4)
}

/** Summarises visible conversation turns into the old memory panel's recent-message format. */
function recentSellerMessages(turns: ChatTurn[]): Array<{ role: string; content: string }> {
  return turns
    .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
    .slice(-6)
    .map((turn) => ({
      role: turn.role === 'user' ? '用户' : '智能客服',
      content: turn.content,
    }))
}

export default function LegacyConsolePage() {
  const [customerId, setCustomerId] = useState('playground-customer')
  const [productId, setProductId] = useState('SUIT-001')
  const [conversationId, setConversationId] = useState('')
  const [manualConversationId, setManualConversationId] = useState('')
  const [manualOrderNo, setManualOrderNo] = useState('ORDER-TEST-1001')
  const [boundOrderNo, setBoundOrderNo] = useState('')
  const [question, setQuestion] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [sessionContext, setSessionContext] = useState('{"channel":"playground","sellerMode":true}')
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [status, setStatus] = useState('页面已加载，等待前端事件。')
  const [debugLog, setDebugLog] = useState<string[]>(['页面已加载，等待前端事件。'])
  const [sending, setSending] = useState(false)
  const [orderSubmitting, setOrderSubmitting] = useState(false)
  const nextId = useRef(1)
  const bottomRef = useRef<HTMLDivElement>(null)

  const activeConversationId = conversationId.trim() || `${customerId}:${productId || 'general'}`
  const latestAgent = [...turns].reverse().find((turn) => turn.role === 'assistant')
  const profile = useMemo(
    () => profileFromTrace(latestAgent?.trace, boundOrderNo),
    [latestAgent?.trace, boundOrderNo],
  )
  const fragments = latestAgent?.trace?.context?.fragments ?? []
  const knowledgeHits = useMemo(
    () => knowledgeHitsFromTrace(latestAgent?.trace),
    [latestAgent?.trace],
  )
  const recentMessages = useMemo(() => recentSellerMessages(turns), [turns])
  const toolCalls = latestAgent?.trace?.toolCalls ?? []
  const toolResults = latestAgent?.trace?.toolResults ?? []
  const llm = latestAgent?.trace?.llm

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [turns, sending])

  /** Appends a timestamped line to the legacy debug log. */
  function log(message: string) {
    const line = `${new Date().toLocaleTimeString()} ${message}`
    setDebugLog((prev) => [line, ...prev].slice(0, 30))
  }

  /** Sends a customer message through the current harness endpoint and refreshes the old boards. */
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
    setStatus('Routing → /api/playground · awaiting response')
    log(`发送消息: ${trimmed || '[图片]'}`)

    try {
      const parsedContext = parseSessionContext(sessionContext)
      const response = await fetch('/api/playground', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId,
          productId,
          conversationId: activeConversationId,
          question: trimmed,
          imageUrl: attachedImageUrl || undefined,
          sessionContext: parsedContext,
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
      setStatus(`✓ 响应完成 · ${reply.terminality} · ${reply.status}`)
      log(`响应完成: trace=${reply.traceId}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setTurns((prev) => [
        ...prev,
        { id: nextId.current++, role: 'system', content: `请求失败：${message}` },
      ])
      setStatus(`✗ 请求失败: ${message}`)
      log(`请求失败: ${message}`)
    } finally {
      setSending(false)
    }
  }

  /** Recreates the old manual order binding behavior through a Next route. */
  async function submitManualOrder() {
    const orderNo = manualOrderNo.trim()
    if (!customerId.trim()) {
      setStatus('请先填写 customerId。')
      return
    }
    if (!orderNo) {
      setStatus('请先填写订单号。')
      return
    }

    setOrderSubmitting(true)
    setStatus('正在提交订单号...')
    log(`提交手动录单: ${orderNo}`)
    try {
      const response = await fetch('/api/orders/place', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId,
          productId,
          conversationId: manualConversationId.trim() || activeConversationId,
          orderNo,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.error ?? '录单失败')
      setBoundOrderNo(orderNo)
      setStatus(`✓ 订单号已记录：${orderNo}`)
      log(`录单成功: ${orderNo}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus(`录单失败: ${message}`)
      log(`录单失败: ${message}`)
    } finally {
      setOrderSubmitting(false)
    }
  }

  return (
    <div className="legacy-console">
      <SellerNavigation active="playground" />
      <header className="legacy-hero">
        <div>
          <p>NEXUS · Rental Seller Console</p>
          <h1>智能客服 · 卖家会话工作台</h1>
          <span>客户资料 · 订单状态 · 手动录单 · 待办跟进</span>
        </div>
        <div className="legacy-hud">
          <span>Reqs {turns.filter((turn) => turn.role === 'assistant').length}</span>
          <span>{status}</span>
        </div>
      </header>

      <div className="legacy-shell">
        <aside className="legacy-sidebar">
          <section>
            <h2>会话配置</h2>
            <label>
              customerId
              <input value={customerId} onChange={(event) => setCustomerId(event.target.value)} />
            </label>
            <label>
              productId
              <input value={productId} onChange={(event) => setProductId(event.target.value)} />
            </label>
          </section>

          <section>
            <h2>手动录单</h2>
            <label>
              conversationId
              <input
                value={manualConversationId}
                placeholder={activeConversationId}
                onChange={(event) => setManualConversationId(event.target.value)}
              />
            </label>
            <label>
              订单号
              <input
                value={manualOrderNo}
                onChange={(event) => setManualOrderNo(event.target.value)}
              />
            </label>
            <button type="button" disabled={orderSubmitting} onClick={submitManualOrder}>
              提交订单号，标记已下单
            </button>
          </section>

          <section>
            <h2>当前会话资料</h2>
            <SessionProfileBoard profile={profile} />
          </section>

          <section>
            <h2>快捷问题</h2>
            <div className="legacy-quick-list">
              {PRESET_QUESTIONS.map((preset) => (
                <button key={preset} type="button" onClick={() => sendMessage(preset)}>
                  {preset}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h2>前端调试</h2>
            <div className="legacy-debug">
              {debugLog.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </section>
        </aside>

        <main className="legacy-main">
          <div className="legacy-chat-topbar">
            <div>
              <h2>实时会话</h2>
              <p>{activeConversationId}</p>
            </div>
            <div>
              <button type="button" onClick={() => setTurns([])}>
                清空显示
              </button>
              <button type="button" onClick={() => sendMessage('我身高180体重70，这款能穿吗？')}>
                固定测试
              </button>
            </div>
          </div>

          <StageRibbon profile={profile} />

          <div className="legacy-chat-history">
            {turns.length === 0 ? (
              <div className="legacy-empty">
                会话尚未开始 · 输入消息即可唤醒智能客服。对话历史、记忆画像与知识命中将实时显示。
              </div>
            ) : (
              turns.map((turn) => <LegacyMessage key={turn.id} turn={turn} />)
            )}
            {sending ? <div className="legacy-typing">Chatty 正在处理...</div> : null}
            <div ref={bottomRef} />
          </div>

          <div className="legacy-composer">
            <div className="legacy-composer-meta">
              <span>Enter 发送，Shift + Enter 换行</span>
              <span>{question.length} chars</span>
            </div>
            <details>
              <summary>高级设置</summary>
              <label>
                conversationId，可选
                <input
                  value={conversationId}
                  onChange={(event) => setConversationId(event.target.value)}
                />
              </label>
              <label>
                sessionContext JSON，可选
                <textarea
                  value={sessionContext}
                  onChange={(event) => setSessionContext(event.target.value)}
                />
              </label>
            </details>
            <label className="legacy-image-url">
              图片链接，可选
              <input
                value={imageUrl}
                placeholder="https://example.com/customer-fit.jpg"
                onChange={(event) => setImageUrl(event.target.value)}
              />
            </label>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                sendMessage(question)
              }}
            >
              <textarea
                value={question}
                placeholder='可直接输入；也可贴图/选图提问（如"这个穿多大？"+图片）'
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

        <aside className="legacy-inspector">
          <section>
            <h2>客户资料</h2>
            <div className="legacy-memory-card">
              <span>客户</span>
              <strong>{customerId}</strong>
              <span>会话</span>
              <strong>{activeConversationId}</strong>
              <span>商品</span>
              <strong>{profile.productText}</strong>
              <span>档期</span>
              <strong>{profile.rentalText}</strong>
            </div>
          </section>

          <section>
            <h2>记忆</h2>
            <SellerMemoryPanel
              profile={profile}
              recentMessages={recentMessages}
              customerId={customerId}
            />
          </section>

          <section>
            <h2>知识命中</h2>
            <KnowledgeHitList hits={knowledgeHits} />
          </section>

          <section>
            <h2>订单待办</h2>
            <div className="legacy-task-list">
              <div>
                <strong>复核尺码</strong>
                <span>{profile.sizeText}</span>
              </div>
              <div>
                <strong>确认订单</strong>
                <span>{profile.orderNo}</span>
              </div>
              <div>
                <strong>下一步</strong>
                <span>{profile.nextAction}</span>
              </div>
            </div>
          </section>

          <section>
            <h2>最近处理</h2>
            <div className="legacy-debug">
              {debugLog.slice(0, 6).map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </section>

          <section>
            <details className="legacy-devtools">
              <summary>开发调试</summary>
              <div className="legacy-memory-card">
                <span>trace</span>
                <strong>{latestAgent?.traceId ?? '等待首轮消息'}</strong>
                <span>terminality</span>
                <strong>{latestAgent?.terminality ?? 'idle'}</strong>
                <span>model</span>
                <strong>{llm?.model ?? 'not called'}</strong>
                <span>LLM calls</span>
                <strong>{llm ? `${llm.calls ?? 0}/${llm.callBudget ?? 0}` : '0/0'}</strong>
                <span>tokens</span>
                <strong>
                  {llm ? `${llm.totalTokens ?? 0} · out ${llm.outputTokens ?? 0}` : '0 · out 0'}
                </strong>
                <span>cache hit</span>
                <strong>
                  {llm ? `${((llm.inputCacheHitRatio ?? 0) * 100).toFixed(1)}%` : '0.0%'}
                </strong>
                <span>est. cost</span>
                <strong>{llm ? `¥${(llm.estimatedCostCny ?? 0).toFixed(6)}` : '¥0.000000'}</strong>
              </div>
              {llm?.operations?.length ? (
                <p className="legacy-muted">LLM ops: {llm.operations.join(' → ')}</p>
              ) : null}
              {llm?.warnings?.length ? (
                <p className="legacy-muted">LLM warnings: {llm.warnings.join(' · ')}</p>
              ) : null}
              {toolCalls.length > 0 ? (
                toolCalls.map((call, index) => (
                  <div className="legacy-tool" key={`${call.toolName}-${call.risk}-${index}`}>
                    <strong>{call.toolName}</strong>
                    <span>{call.risk}</span>
                  </div>
                ))
              ) : (
                <p className="legacy-muted">暂无工具调用</p>
              )}
              {toolResults.length > 0 ? (
                <details className="legacy-fragment">
                  <summary>工具结果</summary>
                  <pre>{JSON.stringify(toolResults, null, 2)}</pre>
                </details>
              ) : null}
              {fragments.map((fragment, index) => (
                <details
                  className="legacy-fragment"
                  key={`${fragment.kind ?? 'fragment'}-${index}`}
                >
                  <summary>{fragment.label ?? fragment.kind ?? 'context'}</summary>
                  <pre>{fragment.content ?? ''}</pre>
                </details>
              ))}
            </details>
          </section>
        </aside>
      </div>
    </div>
  )
}

/** Renders the old session profile cards: product, body, period, price, size, order, review, readiness. */
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

/** Renders the old stage ribbon with completed and pending slots. */
function StageRibbon({ profile }: { profile: SessionProfile }) {
  const steps = [
    ['商品', true],
    ['档期', profile.stage === 'availability_checking' || Boolean(profile.orderNo !== '未录单')],
    ['体型', true],
    ['尺码', profile.stage === 'availability_checking' || Boolean(profile.orderNo !== '未录单')],
    ['复核', profile.orderNo !== '未录单'],
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
          <span>已完成</span>
          <strong>商品 / 体型{profile.orderNo !== '未录单' ? ' / 下单' : ''}</strong>
        </div>
        <div>
          <span>待补充</span>
          <strong>{profile.orderNo === '未录单' ? '复核 / 下单' : '发货复核'}</strong>
        </div>
        <div>
          <span>阻塞项</span>
          <strong>{profile.reviewText === '待复核' ? '尺码与订单复核' : '暂无严重阻塞'}</strong>
        </div>
      </div>
    </div>
  )
}

/** Renders seller-facing memory cards copied from the original console's business meaning. */
function SellerMemoryPanel({
  profile,
  recentMessages,
  customerId,
}: {
  profile: SessionProfile
  recentMessages: Array<{ role: string; content: string }>
  customerId: string
}) {
  return (
    <div className="legacy-memory-sections">
      <div>
        <span>客户全局摘要</span>
        <p>{customerId} · 租赁西装客户，当前重点是尺码、档期和下单前复核。</p>
      </div>
      <div>
        <span>体型档案</span>
        <p>{profile.bodyText}</p>
      </div>
      <div>
        <span>商品会话摘要</span>
        <p>
          {profile.productText} · {profile.rentalText} · {profile.sizeText}
        </p>
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
    return <p className="legacy-muted">发送消息后显示本轮命中的商品、规则或历史知识。</p>
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

/** Renders one chat message in the legacy transcript style. */
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

/** Parses optional sessionContext JSON using the old console's permissive behavior. */
function parseSessionContext(raw: string): Record<string, string | number | boolean> | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const parsed = JSON.parse(trimmed) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('sessionContext 必须是 JSON object')
  }
  return parsed as Record<string, string | number | boolean>
}
