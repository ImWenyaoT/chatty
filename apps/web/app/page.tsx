'use client'

import { FormEvent, useRef, useState } from 'react'

// Verification-only chat surface. Not the final product UI — it exists so a human
// can drive the agent loop end to end and see replies + trace ids during dev.
// A polished client can later fork openai-responses-starter-app instead.

type Turn = {
  id: number
  role: 'user' | 'agent' | 'system'
  text: string
}

const CUSTOMER_ID = 'playground-customer'
const PRODUCT_ID = 'SUIT-001'

export default function PlaygroundPage() {
  const [turns, setTurns] = useState<Turn[]>([
    {
      id: 0,
      role: 'system',
      text: 'Chatty playground. Ask about rental, size, price, or shipping. Replies hit /api/playground.',
    },
  ])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const nextId = useRef(1)

  async function send(event: FormEvent) {
    event.preventDefault()
    const question = input.trim()
    if (!question || sending) return

    const userTurn: Turn = { id: nextId.current++, role: 'user', text: question }
    setTurns((prev) => [...prev, userTurn])
    setInput('')
    setSending(true)

    try {
      const res = await fetch('/api/playground', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId: CUSTOMER_ID,
          productId: PRODUCT_ID,
          question,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setTurns((prev) => [
          ...prev,
          {
            id: nextId.current++,
            role: 'system',
            text: `[${res.status}] ${data?.message ?? data?.error ?? 'request failed'}`,
          },
        ])
        return
      }
      setTurns((prev) => [
        ...prev,
        {
          id: nextId.current++,
          role: 'agent',
          text: `${data.reply ?? '(no reply)'}${data.traceId ? `\n— trace ${data.traceId}` : ''}`,
        },
      ])
    } catch (err) {
      setTurns((prev) => [
        ...prev,
        {
          id: nextId.current++,
          role: 'system',
          text: `network error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ])
    } finally {
      setSending(false)
    }
  }

  return (
    <main className="playground">
      <header>
        <h1>Chatty</h1>
        <p>Rental-commerce agent playground</p>
      </header>

      <section className="messages">
        {turns.map((turn) => (
          <div key={turn.id} className={`msg ${turn.role}`}>
            {turn.text}
          </div>
        ))}
        {sending ? <div className="msg system">thinking…</div> : null}
      </section>

      <div className="composer">
        <form onSubmit={send}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入消息，回车发送"
            disabled={sending}
            autoFocus
          />
          <button type="submit" disabled={sending || !input.trim()}>
            发送
          </button>
        </form>
      </div>
    </main>
  )
}
