import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

// The browser always calls same-origin /api/...; Vite forwards it to the backend (no CORS).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, 'VITE_')
  const proxy = {
    '/api': { target: env.VITE_API_TARGET || 'http://127.0.0.1:8000', changeOrigin: true },
  }

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        // Tether WDK browser shims, see src/wdk/README.md.
        'sodium-universal': fileURLToPath(new URL('./src/wdk/sodium-memzero.ts', import.meta.url)),
        ws: fileURLToPath(new URL('./src/wdk/ws-browser.ts', import.meta.url)),
      },
    },
    server: { host: true, port: 5173, strictPort: true, proxy },
    preview: { host: true, port: 4173, strictPort: true, proxy },
  }
})
