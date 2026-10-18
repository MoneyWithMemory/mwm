import type { Role, SessionState, SessionView } from '@/api'
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

/** Gate reason of the pre-negotiation check: the buyer's maximum is below the seller's minimum. */
export const NO_OVERLAP_PREFIX = 'No deal possible'

export function isNoOverlap(reasons: string[] | undefined): boolean {
  return (reasons ?? []).some((reason) => reason.startsWith(NO_OVERLAP_PREFIX))
}

/** Gate reasons of a negotiation that ended without a deal ("No agreement within 10 rounds."). */
export function isNoAgreement(reasons: string[] | undefined): boolean {
  return (reasons ?? []).some((reason) => reason.startsWith('No agreement'))
}

/** The gate names each side from the buyer's point of view: "Buyer", and "Counterparty" for the seller. */
const TRUST_CHECK: Record<Role, string> = {
  buyer: 'Buyer trust check failed: ',
  seller: 'Counterparty trust check failed: ',
}

/** The tier for which the gate refused the viewer's own wallet (e.g. "Unverified"), or null. */
export function ownTrustFailure(session: Pick<SessionView, 'my_role' | 'gate'>): string | null {
  const prefix = TRUST_CHECK[session.my_role]
  const reason = session.gate?.reasons.find((r) => r.startsWith(prefix))
  return reason === undefined ? null : reason.slice(prefix.length)
}
