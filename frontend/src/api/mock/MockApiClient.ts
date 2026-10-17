import { ApiError, ERROR_CODES, type ApiClient } from '../client'

// Placeholder until M1.5 lands the in-memory engine (seed, negotiation, gate, 7 steps).
function notReady(): Promise<never> {
  return Promise.reject(new ApiError(ERROR_CODES.notImplemented, 'Mock API not available yet (M1.5)'))
}

export class MockApiClient implements ApiClient {
  health = notReady
  market = notReady
  listWallets = notReady
  getWallet = notReady
  createWallet = notReady
  setAlias = notReady
  updateAgentProfile = notReady
  getContacts = notReady
  createSession = notReady
  listSessions = notReady
  getSession = notReady
  sign = notReady
  cancel = notReady
}
