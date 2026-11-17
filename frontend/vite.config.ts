import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
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
