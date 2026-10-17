import { useCallback, useEffect, useEffectEvent, useState } from 'react'
import { api } from './api'
import { toApiError, type ApiError } from './client'
import type { SessionId, SessionSummary, ShopQuery, WalletId } from './types'

/** Polling intervals (ms). Negotiation turns take a few seconds; settlement steps faster. */
export const POLL_MS = {
  session: 1000,
  sessions: 1500,
  wallet: 1500,
  contacts: 5000,
  shop: 4000,
  health: 5000,
  market: 10_000,
  wallets: 10_000,
} as const

// Every successful mutation refreshes all mounted polls, so both panes update at once.
const refreshers = new Set<() => void>()

export function invalidateAll(): void {
  refreshers.forEach((refresh) => refresh())
}

export interface PollState<T> {
  /** Last good value; kept on refetch and on error so the UI never flickers. */
  data: T | undefined
  error: ApiError | null
  /** True only until the first response (or error) for the current key. */
  loading: boolean
  refresh: () => void
}

type Snapshot<T> = { key: string | null; data: T | undefined; error: ApiError | null }

/**
 * Fetches `fetcher` for `key` (null disables), then every `intervalMs` while the
 * tab is visible. One request in flight at a time; aborted on key change/unmount.
 */
export function usePoll<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>, intervalMs?: number): PollState<T> {
  const [snap, setSnap] = useState<Snapshot<T>>({ key: null, data: undefined, error: null })
  const [tick, setTick] = useState(0)
  const fetchLatest = useEffectEvent(fetcher)
  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    refreshers.add(refresh)
    return () => {
      refreshers.delete(refresh)
    }
  }, [refresh])

  useEffect(() => {
    if (key === null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    let stopped = false

    const run = () => {
      clearTimeout(timer)
      controller?.abort()
      const current = new AbortController()
      controller = current
      fetchLatest(current.signal)
        .then(
          (data) => {
            if (!current.signal.aborted) setSnap({ key, data, error: null })
          },
          (err: unknown) => {
            if (current.signal.aborted) return
            const error = toApiError(err)
            setSnap((s) => ({ key, data: s.key === key ? s.data : undefined, error }))
          },
        )
        .finally(() => {
          if (stopped || current.signal.aborted || intervalMs === undefined || document.hidden) return
          timer = setTimeout(run, intervalMs)
        })
    }

    const onVisibility = () => {
      if (!document.hidden) run()
    }

    run()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [key, intervalMs, tick])

  const current = snap.key === key ? snap : undefined
  return {
    data: current?.data,
    error: current?.error ?? null,
    loading: key !== null && current === undefined,
    refresh,
  }
}

// ── Queries ────────────────────────────────────────────────────────

export function useHealth() {
  return usePoll('health', (signal) => api.health({ signal }), POLL_MS.health)
}

export function useMarket() {
  return usePoll('market', (signal) => api.market({ signal }), POLL_MS.market)
}

export function useWallets() {
  return usePoll('wallets', (signal) => api.listWallets({ signal }), POLL_MS.wallets)
}

export function useWallet(walletId: WalletId | null) {
  return usePoll(walletId && `wallet:${walletId}`, (signal) => api.getWallet(walletId as WalletId, { signal }), POLL_MS.wallet)
}

export function useContacts(walletId: WalletId | null) {
  return usePoll(walletId && `contacts:${walletId}`, (signal) => api.getContacts(walletId as WalletId, { signal }), POLL_MS.contacts)
}

export function useSessions(walletId: WalletId | null) {
  return usePoll(walletId && `sessions:${walletId}`, (signal) => api.listSessions(walletId as WalletId, { signal }), POLL_MS.sessions)
}

/** How many of walletId's deals wait for its signature (drives the Deals badge). */
export function usePendingSignatureCount(walletId: WalletId | null): number {
  const sessions = useSessions(walletId)
  return (sessions.data ?? []).filter((s) => s.needs_my_signature).length
}

export interface PendingSignature {
  walletId: WalletId
  session: SessionSummary
}

/** Deals waiting for a signature across several wallets, oldest first (drives the header prompt). */
export function usePendingSignatures(walletIds: WalletId[]) {
  const key = walletIds.length > 0 ? `pending:${walletIds.join(',')}` : null
  return usePoll(
    key,
    async (signal): Promise<PendingSignature[]> => {
      const lists = await Promise.all(walletIds.map((id) => api.listSessions(id, { signal })))
      return lists
        .flatMap((sessions, i) => sessions.filter((s) => s.needs_my_signature).map((session) => ({ walletId: walletIds[i], session })))
        .sort((a, b) => a.session.created_at - b.session.created_at)
    },
    POLL_MS.sessions,
  )
}

/** The session from walletId's perspective (my_role, my_private_thought). */
export function useSession(sessionId: SessionId | null, walletId: WalletId | null) {
  const key = sessionId && walletId ? `session:${sessionId}:${walletId}` : null
  return usePoll(key, (signal) => api.getSession(sessionId as SessionId, walletId as WalletId, { signal }), POLL_MS.session)
}

/** Public Shop listings as seen by walletId: active Seller Desks plus open requests. */
export function useShop(walletId: WalletId | null, query: ShopQuery = {}) {
  const key = walletId && `shop:${walletId}:${query.kind ?? ''}:${query.asset_id ?? ''}:${query.q ?? ''}`
  return usePoll(key, (signal) => api.getShop(walletId as WalletId, query, { signal }), POLL_MS.shop)
}

// ── Mutations ──────────────────────────────────────────────────────

export interface MutationState<A extends unknown[], R> {
  /** Resolves with the result; rejects with ApiError (also exposed as `error`). */
  run: (...args: A) => Promise<R>
  pending: boolean
  error: ApiError | null
  reset: () => void
}

/**
 * Wraps an API call with pending/error state and refreshes every poll on success.
 * Pass a stable function (module-level or memoized) so `run` stays stable.
 */
export function useMutation<A extends unknown[], R>(fn: (...args: A) => Promise<R>): MutationState<A, R> {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  const run = useCallback(async (...args: A) => {
    setPending(true)
    setError(null)
    try {
      const result = await fn(...args)
      invalidateAll()
      return result
    } catch (err) {
      const apiError = toApiError(err)
      setError(apiError)
      throw apiError
    } finally {
      setPending(false)
    }
  }, [fn])

  const reset = useCallback(() => setError(null), [])
  return { run, pending, error, reset }
}

const createSession = (...args: Parameters<typeof api.createSession>) => api.createSession(...args)
const sign = (...args: Parameters<typeof api.sign>) => api.sign(...args)
const cancel = (...args: Parameters<typeof api.cancel>) => api.cancel(...args)
const setAlias = (...args: Parameters<typeof api.setAlias>) => api.setAlias(...args)
const updateAgentProfile = (...args: Parameters<typeof api.updateAgentProfile>) => api.updateAgentProfile(...args)
const createWallet = (...args: Parameters<typeof api.createWallet>) => api.createWallet(...args)
const createWant = (...args: Parameters<typeof api.createWant>) => api.createWant(...args)
const closeListing = (...args: Parameters<typeof api.closeListing>) => api.closeListing(...args)
const agentSearch = (...args: Parameters<typeof api.agentSearch>) => api.agentSearch(...args)

export const useCreateSession = () => useMutation(createSession)
export const useSign = () => useMutation(sign)
export const useCancel = () => useMutation(cancel)
export const useSetAlias = () => useMutation(setAlias)
export const useUpdateAgentProfile = () => useMutation(updateAgentProfile)
export const useCreateWallet = () => useMutation(createWallet)
export const useCreateWant = () => useMutation(createWant)
export const useCloseListing = () => useMutation(closeListing)
export const useAgentSearch = () => useMutation(agentSearch)
