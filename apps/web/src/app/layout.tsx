import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import '../globals.css'

export const metadata: Metadata = {
  title: 'Chatty Agent Workbench',
  description: '可追溯研究、内容生成、人工批准与沙箱导出工作台',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        {children}
      </body>
    </html>
  )
}
