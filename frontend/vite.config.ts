import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 开发代理：/api -> 本地后端（api_server.py 默认 8000 端口）
// 生产由部署方提供同源 /api 反代，或构建前用 VITE_API_BASE 覆盖。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // 仅新增能力：既有相对导入保持原样，新代码可用 @/lib/... 形式
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: './src/test/setup.ts',
    css: false,
    testTimeout: 20_000,
  },
})
