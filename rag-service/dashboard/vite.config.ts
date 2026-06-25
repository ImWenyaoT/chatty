import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  build: {
    outDir: path.resolve(currentDir, '..', 'public', 'dashboard'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // 开发模式下代理 API 到 Fastify
      '/chat': 'http://127.0.0.1:3001',
      '/memory': 'http://127.0.0.1:3001',
      '/memories': 'http://127.0.0.1:3001',
      '/reviews': 'http://127.0.0.1:3001',
      '/config': 'http://127.0.0.1:3001',
      '/health': 'http://127.0.0.1:3001',
    },
  },
});
