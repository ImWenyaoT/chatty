import type { ReactNode } from 'react'
import './globals.css'

export const metadata = {
  title: 'Chatty',
  description: 'Agentic customer-service prototype for rental commerce.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  )
}
