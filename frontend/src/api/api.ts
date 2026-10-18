import type { ApiClient } from './client'
import { HttpApiClient } from './http'
import { MockApiClient } from './mock/MockApiClient'

/** "mock" (default) runs fully in the browser; "http" talks to the backend via the /api proxy. */
export const API_MODE: 'mock' | 'http' = import.meta.env.VITE_API_MODE === 'http' ? 'http' : 'mock'

export const api: ApiClient = API_MODE === 'http' ? new HttpApiClient() : new MockApiClient()
