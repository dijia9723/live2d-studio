import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const visionEntry = createRequire(import.meta.url).resolve('@mediapipe/tasks-vision')
const desktopDevURL = process.env.FRONTEND_DEVSERVER_URL
  ? new URL(process.env.FRONTEND_DEVSERVER_URL)
  : undefined

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // 与 tsconfig 的 @/* 别名保持一致，供 shadcn/ui 组件互相引用。
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@mediapipe-vision-wasm': join(dirname(visionEntry), 'wasm'),
    },
  },
  optimizeDeps: { exclude: ['@mediapipe-vision-wasm'] },
  server: {
    port: 5173,
    strictPort: true,
    hmr: desktopDevURL
      ? { host: desktopDevURL.hostname, clientPort: Number(desktopDevURL.port || 80) }
      : undefined,
    proxy: {
      '/api': 'http://127.0.0.1:12393',
      '/models': 'http://127.0.0.1:12393',
      '/scene-media': 'http://127.0.0.1:12393',
    },
  },
  build: {
    outDir: '../server/internal/webui/dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          pixi: ['pixi.js'],
          markdown: ['react-markdown'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
})
