'use client'

import { useEffect, useRef, useState } from 'react'
import { SessionBar } from './components/SessionBar'
import { ChatMessage } from './components/ChatMessage'
import { Composer } from './components/Composer'
import type { PlaygroundResponse, Turn } from './components/types'

// Chatty concierge surface. Drives the bounded agent loop via /api/playground and
// renders what the loop actually returns: the reply, a live session status, the
// human-handoff state, and a per-message trace detail for debugging.

const EXAMPLE_PROMPTS = [
  '这件西装多少钱一天？',
  '4月29到30号有货吗？',
  '我身高180体重70，这款能穿吗？',
  '我要退款',
]

/** A reply is a handoff when the loop escalates to a human. */
function isHandoff(res: PlaygroundResponse): boolean {
  return res.terminality === 'handoff_and_wait' || res.status === 'waiting_for_human'
}

export default function ConciergePage() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState('active')
  const [productId, setProductId] = useState('SUIT-001')
  const [customerId, setCustomerId] = useState('playground-customer')
  const nextId = useRef(1)
  const bottom = useRef<HTMLDivElement>(null)

  // Keep the latest turn (and the typing indicator) in view.
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns, sending])

  async function send(question: string) {
    const text = question.trim()
    if (!text || sending) return

    setTurns((prev) => [...prev, { id: nextId.current++, role: 'user', text }])
    setInput('')
    setSending(true)

    try {
      const res = await fetch('/api/playground', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customerId, productId, question: text }),
      })
      const data = await res.json()

      if (!res.ok) {
        setTurns((prev) => [
          ...prev,
          {
            id: nextId.current++,
            role: 'system',
            error: true,
            text: `[${res.status}] ${data?.error ?? data?.message ?? '请求失败'}`,
          },
        ])
        return
      }

      const reply = data as PlaygroundResponse
      const handoff = isHandoff(reply)
      setStatus(reply.status)
      setTurns((prev) => [
        ...prev,
        {
          id: nextId.current++,
          role: 'agent',
          handoff,
          text: reply.reply || '（无回复）',
          traceId: reply.traceId,
          sessionId: reply.sessionId,
          status: reply.status,
          terminality: reply.terminality,
        },
      ])
    } catch (err) {
      setTurns((prev) => [
        ...prev,
        {
          id: nextId.current++,
          role: 'system',
          error: true,
          text: `网络错误：${err instanceof Error ? err.message : String(err)}`,
        },
      ])
    } finally {
      setSending(false)
    }
  }

  return (
    <main className="shell">
      <SessionBar
        status={status}
        productId={productId}
        customerId={customerId}
        disabled={sending}
        onProductId={setProductId}
        onCustomerId={setCustomerId}
      />

      <section className="stream">
        {turns.length === 0 && !sending ? (
          <div className="empty">
            <h2>在的，您想租点什么？</h2>
            <p>问问租期、尺码、价格或物流，超出范围我会帮您转人工。</p>
            <div className="prompts">
              {EXAMPLE_PROMPTS.map((p) => (
                <button key={p} type="button" onClick={() => send(p)}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {turns.map((turn) => (
          <ChatMessage key={turn.id} turn={turn} />
        ))}

        {sending ? (
          <div className="typing" aria-label="Chatty 正在输入">
            <span />
            <span />
            <span />
          </div>
        ) : null}
        <div ref={bottom} />
      </section>

      <Composer value={input} sending={sending} onChange={setInput} onSubmit={() => send(input)} />
    </main>
  )
}
