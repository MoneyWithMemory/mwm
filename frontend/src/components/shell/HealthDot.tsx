import { API_MODE, useHealth } from '@/api'
import { cn } from '@/lib/cn'

const DOT = {
  ok: 'bg-success',
  degraded: 'bg-warning',
  down: 'bg-danger',
  loading: 'bg-hint',
} as const

/** API mode (Mock / Live) plus a dot for backend, QVAC, regtest and proxy reachability. */
export function HealthDot() {
  const health = useHealth()
  const status: keyof typeof DOT = health.error
    ? 'down'
    : !health.data
      ? 'loading'
      : Object.values(health.data).every(Boolean)
        ? 'ok'
        : 'degraded'
  const mode = API_MODE === 'mock' ? 'Mock' : 'Live'
  const detail = health.data
    ? `QVAC ${health.data.qvac ? 'up' : 'down'}, regtest ${health.data.regtest ? 'up' : 'down'}, proxy ${health.data.proxy ? 'up' : 'down'}`
    : health.error
      ? 'backend unreachable'
      : 'checking'

  return (
    <span
      className="badge-nowrap inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-xs font-medium text-hint shadow-card"
      title={`${mode} API: ${detail}`}
      role="status"
      aria-label={`${mode} API: ${detail}`}
    >
      <span className={cn('size-2 rounded-full transition-colors duration-150 ease-smooth-out', DOT[status])} aria-hidden="true" />
      {mode}
    </span>
  )
}
