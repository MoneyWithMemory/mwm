/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_MODE?: 'mock' | 'http'
  readonly VITE_API_TARGET?: string
  readonly VITE_VAULT_TARGET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
