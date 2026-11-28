import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createReadStream, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const resolve = createRequire(import.meta.url).resolve
const visionEntry = resolve('@mediapipe/tasks-vision')
const ocrAssetsDir = join(
  dirname(fileURLToPath(import.meta.resolve('@paddleocr/paddleocr-js'))),
  'assets',
)
const ocrOrtDir = dirname(resolve('onnxruntime-web'))
const ocrWorker = readdirSync(ocrAssetsDir).find((name) => /^worker-entry-.+\.js$/.test(name))
if (!ocrWorker) throw new Error('找不到本地 OCR 工作线程')
const ocrRuntimeAssets = new Map([
  ['ocr/worker.mjs', join(ocrAssetsDir, ocrWorker)],
  ...['.jsep.mjs', '.jsep.wasm'].map((ext) => {
    const name = `ort-wasm-simd-threaded${ext}`
    return [`ocr/${name}`, join(ocrOrtDir, name)] as const
  }),
])
const desktopDevURL = process.env.FRONTEND_DEVSERVER_URL
  ? new URL(process.env.FRONTEND_DEVSERVER_URL)
  : undefined

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'local-screen-ocr',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const name = request.url?.split('?')[0].slice(1) ?? ''
          const asset = ocrRuntimeAssets.get(name)
          if (!asset) return next()
          response.setHeader(
            'Content-Type',
            name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
          )
          createReadStream(asset).pipe(response)
        })
      },
      generateBundle() {
        for (const [fileName, path] of ocrRuntimeAssets) {
          // Vite emits the SDK's default worker through its import.meta.url reference.
          if (fileName === 'ocr/worker.mjs') continue
          this.emitFile({ type: 'asset', fileName, source: readFileSync(path) })
        }
      },
    },
  ],
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
      '/api': { target: 'http://127.0.0.1:12393', ws: true },
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
