'use client'

import { useEffect, useRef } from 'react'

// 底部 sticky Composer：48px 自增高输入框 + primary 发送按钮。
// Enter 发送，Shift+Enter 换行。

type Props = {
  value: string
  sending: boolean
  onChange: (v: string) => void
  onSubmit: () => void
}

/** Composer：三段式布局的第三段，唯一的消息入口。 */
export function Composer({ value, sending, onChange, onSubmit }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // 让 textarea 随内容自增高（上限由 CSS max-height 控制）。
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  const canSend = value.trim().length > 0 && !sending

  return (
    <div className="composer">
      <div className="composer-inner">
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
            // biome-ignore lint/a11y/noAutofocus: 聊天台唯一输入框，进页即打字是核心交互
            autoFocus
            aria-label="输入消息"
          />
          <button className="send" type="submit" disabled={!canSend}>
            发送
          </button>
        </form>
        <p className="hint">
          <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
        </p>
      </div>
    </div>
  )
}
