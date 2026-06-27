import type { ReactNode } from 'react'
import { Fraunces, Hanken_Grotesk } from 'next/font/google'
import './globals.css'

// Display serif (brand wordmark + headers) — characterful, editorial, a touch of
// fashion. Body grotesque for chat/UI. Latin only; CJK falls back to the system
// stack declared in globals.css so we don't ship a huge CJK web font.
const display = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
})

const body = Hanken_Grotesk({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})

export const metadata = {
  title: 'Chatty · 租衣客服',
  description: 'Agentic customer-service concierge for rental commerce.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  )
}
