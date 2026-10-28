import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// 开发代理：/api -> 本地后端（api_server.py 默认 8000 端口）
// 生产构建后由部署方（lead 补充）提供同源 /api 反代，或用 VITE_API_BASE 覆盖。
export default defineConfig({
  plugins: [react()],
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
  },
})
