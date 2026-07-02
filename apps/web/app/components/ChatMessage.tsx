'use client'

import type { Turn } from './types'

// Renders one turn. User/agent/system each get distinct styling; an agent turn
// flagged as a handoff shows the escalation treatment, and every agent turn
// carries a collapsible trace detail (this is a developer playground).

/** Small icons kept inline so the bundle has no icon dependency. */
function HandoffIcon() {
  return (
    <svg
      width="16"
      height="16"
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

function Chevron() {
  return (
    <svg
      className="chev"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      aria-hidden="true"
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  )
}

export function ChatMessage({ turn }: { turn: Turn }) {
  if (turn.role === 'system') {
    return (
      <div className={`turn system${turn.error ? ' error' : ''}`}>
        <div className="bubble">{turn.text}</div>
      </div>
    )
  }

  if (turn.role === 'user') {
    return (
      <div className="turn user">
        <span className="who">你</span>
        <div className="bubble">{turn.text}</div>
      </div>
    )
  }

  // agent (possibly a handoff)
  return (
    <div className={`turn ${turn.handoff ? 'handoff' : 'agent'}`}>
      <span className="who">{turn.handoff ? '转接人工' : 'Chatty'}</span>
      <div className="bubble">
        {turn.handoff ? <HandoffIcon /> : null}
        <span>{turn.text}</span>
      </div>
      {turn.traceId ? (
        <details className="trace">
          <summary>
            <Chevron /> trace
          </summary>
          <div className="trace-body">
            <div>
              <b>terminality</b> {turn.terminality}
            </div>
            <div>
              <b>status</b> {turn.status}
            </div>
            <div>
              <b>trace</b> {turn.traceId}
            </div>
            <div>
              <b>session</b> {turn.sessionId}
            </div>
          </div>
        </details>
      ) : null}
    </div>
  )
}
