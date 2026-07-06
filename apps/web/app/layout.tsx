import type { ReactNode } from 'react'
import { GeistMono } from 'geist/font/mono'
import { GeistSans } from 'geist/font/sans'
import './globals.css'

// Geist Sans（UI/正文）+ Geist Mono（harness 遥测）。官方包只带 latin，
// CJK 走 globals.css 里声明的系统字体回退，避免打包巨大的中文 web font。

export const metadata = {
  title: 'Chatty · 租衣客服',
  description: 'Agentic customer-service concierge for rental commerce.',
}

export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
  ],
}

/** 根布局：挂载 Geist 字体的 CSS 变量（--font-geist-sans / --font-geist-mono）。 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        {children}
      </body>
    </html>
  )
}
