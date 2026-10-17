import type { SessionState } from '@/api'
import type { BadgeVariant } from '@/components/ui'

/** One label and badge variant per session state, shared by every view that lists sessions. */
export const SESSION_STATE_LABEL: Record<SessionState, string> = {
  NEGOTIATING: 'Negotiating',
  AWAITING_SIGNATURES: 'Awaiting signatures',
  SETTLING: 'Settling',
  SETTLED: 'Settled',
  CANCELLED_BY_USER: 'Cancelled',
  BLOCKED_BY_GATE: 'Blocked',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
}

export const SESSION_STATE_VARIANT: Record<SessionState, BadgeVariant> = {
  NEGOTIATING: 'accent',
  AWAITING_SIGNATURES: 'warning',
  SETTLING: 'accent',
  SETTLED: 'success',
  CANCELLED_BY_USER: 'default',
  BLOCKED_BY_GATE: 'danger',
  FAILED: 'danger',
  EXPIRED: 'default',
}
