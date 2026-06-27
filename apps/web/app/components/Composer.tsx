'use client'

import { useEffect, useRef } from 'react'

// Auto-growing message composer. Enter sends, Shift+Enter inserts a newline.

type Props = {
  value: string
  sending: boolean
  onChange: (v: string) => void
  onSubmit: () => void
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  )
}

export function Composer({ value, sending, onChange, onSubmit }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Grow the textarea to fit its content (capped by max-height in CSS).
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  const canSend = value.trim().length > 0 && !sending

  return (
    <div className="composer">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (canSend) onSubmit()
        }}
      >
        <textarea
          ref={ref}
          value={value}
          rows={1}
          placeholder="问问租期、尺码、价格、物流…"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (canSend) onSubmit()
            }
          }}
          autoFocus
          aria-label="输入消息"
        />
        <button className="send" type="submit" disabled={!canSend} aria-label="发送">
          <SendIcon />
        </button>
      </form>
      <p className="hint">
        <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
      </p>
    </div>
  )
}
