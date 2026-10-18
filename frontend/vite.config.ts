import type { IncomingMessage } from 'node:http'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * The Vault service listens on this computer only, and so does its proxy: other devices on the
 * LAN get the app and /api, but /vault answers them 404 (an unlocked Vault moves funds without
 * asking for its password again).
 */
const vaultOnThisComputer = (req: IncomingMessage) => (LOOPBACK.has(req.socket.remoteAddress ?? '') ? undefined : false)

// The browser always calls same-origin /api/... and /vault/...; Vite forwards them to the
// backend and to the Vault service (no CORS).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, 'VITE_')
  const proxy = {
    '/api': { target: env.VITE_API_TARGET || 'http://127.0.0.1:8000', changeOrigin: true },
    '/vault': { target: env.VITE_VAULT_TARGET || 'http://127.0.0.1:8200', changeOrigin: true, bypass: vaultOnThisComputer },
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
