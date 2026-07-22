import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const chattyApiTarget = process.env.CHATTY_API_TARGET ?? 'http://127.0.0.1:8000'

// 裁决（decisions.md §1.6）：FastAPI 直接在 /api/chatty 前缀下挂全部路由，
// 代理原样透传，任何地方都不改写前缀。
const chattyApiProxy = {
  '/api/chatty': {
    target: chattyApiTarget,
  },
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  server: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    proxy: chattyApiProxy,
  },
  preview: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    proxy: chattyApiProxy,
  },
})
