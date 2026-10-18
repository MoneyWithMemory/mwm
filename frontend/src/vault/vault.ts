import { API_MODE } from '@/api/api'
import type { VaultClient } from './client'
import { HttpVaultClient } from './http'
import { MockVaultClient } from './mock'

/** Follows the backend's mode: in mock mode both run in the browser and move balances together. */
export const vault: VaultClient = API_MODE === 'http' ? new HttpVaultClient() : new MockVaultClient()
