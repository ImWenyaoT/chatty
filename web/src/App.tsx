import { useEffect, useRef, useState } from 'react'
import {
  ApiError,
  createSession,
  explain,
  fetchCatalog,
  takeTurn,
  type CatalogInfo,
  type Product,
  type Turn,
} from './api'

/**
 * 会话里的一条记录。
 *
 * `understood` 单独占一条是刻意的：这个项目的论点是「模型说了不算」，而输入适配把
 * 大白话解析成什么条件，正是第一处「模型说了算不算」的地方——让人看见它，比直接
 * 跳到结果更说明问题。
 */
type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'understood'; text: string }
  | { kind: 'question'; text: string }
  | { kind: 'products'; products: Product[]; latencyMs: number }
  | { kind: 'error'; code: string }

const yuan = (cents: number) => (cents / 100).toFixed(2)

export default function App() {
  const [info, setInfo] = useState<CatalogInfo | null>(null)
  const [userId, setUserId] = useState('user_active')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [turnsLeft, setTurnsLeft] = useState<number | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchCatalog()
      .then(setInfo)
      .catch((error: unknown) =>
        setBootError(error instanceof ApiError ? explain(error.code) : '连不上后端'),
      )
  }, [])

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries, busy])

  const reset = (nextUser = userId) => {
    setUserId(nextUser)
    setSessionId(null)
    setEntries([])
    setTurnsLeft(null)
  }

  const send = async (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed || busy) return

    setText('')
    setEntries((current) => [...current, { kind: 'user', text: trimmed }])
    setBusy(true)
    try {
      // 会话惰性开：换了身份却不发消息，就不该占一个会话
      const id = sessionId ?? (await createSession(userId)).session_id
      if (id !== sessionId) setSessionId(id)

      const turn: Turn = await takeTurn(id, trimmed)
      setTurnsLeft(turn.turns_left)
      setEntries((current) => [
        ...current,
        { kind: 'understood', text: turn.understood_as },
        turn.kind === 'recommend'
          ? { kind: 'products', products: turn.products, latencyMs: turn.latency_ms }
          : { kind: 'question', text: turn.question ?? '' },
      ])
    } catch (error: unknown) {
      const code = error instanceof ApiError ? error.code : 'network_error'
      setEntries((current) => [...current, { kind: 'error', code }])
    } finally {
      setBusy(false)
    }
  }

  if (bootError) {
    return (
      <main className="boot-error">
        <p>{bootError}</p>
        <p className="hint">
          先起后端：<code>pnpm dev</code>
        </p>
      </main>
    )
  }

  const exhausted = turnsLeft !== null && turnsLeft <= 0

  return (
    <div className="app">
      <header>
        <div>
          <h1>Chatty</h1>
          <p className="hint">
            {info
              ? `${info.model_id} · ${info.product_count} 件商品 · ${info.categories.length} 个类目`
              : '载入中…'}
          </p>
        </div>
        <label className="identity">
          身份
          <select value={userId} onChange={(event) => reset(event.target.value)} disabled={busy}>
            {info?.users.map((user) => (
              <option key={user} value={user}>
                {user}
              </option>
            ))}
          </select>
        </label>
      </header>

      <main>
        {entries.length === 0 && info && (
          <section className="intro">
            <p>用大白话说需求，比如「想买个降噪耳机，2000 以内」。</p>
            <p className="hint">类目：{info.categories.join('、')}</p>
            <p className="hint">换个身份问同样的需求，能看出画像对结果的影响。</p>
          </section>
        )}

        {entries.map((entry, index) => (
          <Bubble key={index} entry={entry} />
        ))}

        {busy && <p className="thinking">画像 → 搜索 → 库存 → 知识检索 → 营销策略…</p>}
        <div ref={bottom} />
      </main>

      <footer>
        {exhausted && (
          <p className="hint">
            这段对话问到头了。
            <button type="button" className="link" onClick={() => reset()}>
              开一段新的
            </button>
          </p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void send(text)
          }}
        >
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={busy ? '正在跑…' : '想买点什么？'}
            disabled={busy || exhausted}
          />
          <button type="submit" disabled={busy || !text.trim() || exhausted}>
            发送
          </button>
        </form>
      </footer>
    </div>
  )
}

function Bubble({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case 'user':
      return <p className="bubble user">{entry.text}</p>
    case 'understood':
      return <p className="understood">理解为 · {entry.text}</p>
    case 'question':
      return <p className="bubble agent">{entry.text}</p>
    case 'error':
      return (
        <p className="bubble error">
          {explain(entry.code)}
          <span className="code">{entry.code}</span>
        </p>
      )
    case 'products':
      return (
        <section className="products">
          <p className="hint">跑完五个工具，{(entry.latencyMs / 1000).toFixed(1)}s</p>
          {entry.products.map((product) => (
            <ProductCard key={product.product_id} product={product} />
          ))}
          <p className="hint">
            ID、名称、价格与库存均来自 SQLite 重查，并通过 Harness
            六条证据校验；模型只写了理由和文案。
          </p>
        </section>
      )
  }
}

function ProductCard({ product }: { product: Product }) {
  return (
    <article className="card">
      <div className="card-head">
        <span className="name">{product.name}</span>
        <span className="price">¥{yuan(product.price_cents)}</span>
      </div>
      <p className="meta">
        <span className="id">{product.product_id}</span>
        <span>{product.brand}</span>
        <span className={product.low_stock ? 'low' : ''}>
          {product.low_stock ? '库存紧张' : '有货'}
        </span>
        {product.tags.map((tag) => (
          <span key={tag} className="tag">
            {tag}
          </span>
        ))}
      </p>
      <p className="reason">{product.reason}</p>
      <p className="copy">{product.marketing_copy}</p>
    </article>
  )
}
