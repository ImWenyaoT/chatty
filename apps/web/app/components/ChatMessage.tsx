'use client'

import type { Turn } from './types'

// 单条回合渲染：user 右侧灰底气泡；agent 左侧纯文本，下方跟一条 mono 遥测条
// （loop 实际返回的 terminality / status / trace / session，不编造字段）；
// handoff 额外挂一枚人工转接标记；system 居中 mono 行，error 走红色。

/** 人工转接标记的内联图标（装饰性，aria-hidden，避免引入图标依赖）。 */
function HandoffIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6M22 11h-6" />
    </svg>
  )
}

/** 把一次 loop 应答里实际存在的遥测字段拼成一条 mono 遥测文本。 */
function telemetryLine(turn: Turn): string {
  const parts: string[] = []
  if (turn.terminality) parts.push(turn.terminality)
  if (turn.status) parts.push(turn.status)
  if (turn.harnessTrace?.task?.kind) parts.push(`task ${turn.harnessTrace.task.kind}`)
  if (turn.harnessTrace?.action?.action) parts.push(`action ${turn.harnessTrace.action.action}`)
  if (turn.traceId) parts.push(`trace ${turn.traceId}`)
  if (turn.sessionId) parts.push(`session ${turn.sessionId}`)
  return parts.join(' · ')
}

/** 渲染 Harness trace 的最小可观测详情，避免 GUI 隐藏关键决策依据。 */
function HarnessTraceDetails({ turn }: { turn: Turn }) {
  const trace = turn.harnessTrace
  if (!trace) return null
  const fragments = trace.context?.fragments ?? []
  const toolCalls = trace.toolCalls ?? []
  return (
    <details className="trace-details">
      <summary>Harness trace</summary>
      <dl>
        <div>
          <dt>task</dt>
          <dd>{trace.task?.kind ?? 'unknown'}</dd>
        </div>
        <div>
          <dt>goal</dt>
          <dd>{trace.task?.goal ?? 'unknown'}</dd>
        </div>
        <div>
          <dt>action</dt>
          <dd>{trace.action?.action ?? 'unknown'}</dd>
        </div>
        <div>
          <dt>tool</dt>
          <dd>
            {trace.action?.toolName ?? (toolCalls.length > 0 ? toolCalls[0].toolName : 'none')}
          </dd>
        </div>
      </dl>
      {fragments.length > 0 ? (
        <div className="trace-fragments">
          {fragments.map((fragment, index) => (
            <section key={`${fragment.kind ?? 'fragment'}-${index}`}>
              <h3>{fragment.label ?? fragment.kind ?? 'context'}</h3>
              <pre>{fragment.content ?? ''}</pre>
            </section>
          ))}
        </div>
      ) : null}
    </details>
  )
}

/** 渲染一条对话回合（user / agent / system）。 */
export function ChatMessage({ turn }: { turn: Turn }) {
  if (turn.role === 'system') {
    return <p className={`turn-system${turn.error ? ' is-error' : ''}`}>{turn.text}</p>
  }

  if (turn.role === 'user') {
    return (
      <div className="turn turn-user">
        <span className="sr-only">你：</span>
        <div className="msg-bubble">{turn.text}</div>
      </div>
    )
  }

  // agent（可能带 handoff 标记）
  const telemetry = telemetryLine(turn)
  return (
    <div className="turn turn-agent">
      <span className="sr-only">Chatty：</span>
      {turn.handoff ? (
        <span className="handoff-flag">
          <HandoffIcon />
          已转接人工
        </span>
      ) : null}
      <div className="msg-text">{turn.text}</div>
      {telemetry ? <p className="telemetry">{telemetry}</p> : null}
      <HarnessTraceDetails turn={turn} />
    </div>
  )
}
