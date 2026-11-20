import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    server: {
      // 必须显式走 IPv4：Chromium 对 localhost 可能优先用 127.0.0.1，
      // 而 vite 默认只绑 IPv6(::1)，会导致渲染进程连不上 dev server
      host: '127.0.0.1'
    }
  }
})
