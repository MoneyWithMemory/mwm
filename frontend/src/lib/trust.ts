import type { TrustTier } from '@/api/types'

/** Every way of being untrustworthy, a thin or broken history or a trading loop, reads the same. */
const LOW_RELIABILITY = {
  label: 'Low reliability',
  explanation:
    'Little reliable trade history, or unusual behavior such as trading in loops or walking away from agreed deals. Trading with this address is a risk.',
}

/**
 * The UI's words for each trust tier of the contract. Every way of being untrustworthy is one
 * "Low reliability": a user needs to know there is a risk, not which kind. Each label has one
 * explanation, the same for every wallet (never a per-wallet description).
 */
const TRUST_COPY: Record<TrustTier, { label: string; explanation: string }> = {
  'High Authenticity': {
    label: 'High Authenticity',
    explanation: 'Settled trades with many independent wallets, and nothing unusual.',
  },
  'Low Reliability': LOW_RELIABILITY,
  'Ring Anomaly Detected': LOW_RELIABILITY,
  Unverified: {
    label: 'Unverified',
    explanation: 'Not enough trade history yet to score this address.',
  },
}

/** "Low reliability" for both "Low Reliability" and "Ring Anomaly Detected". */
export function trustLabel(tier: TrustTier): string {
  return TRUST_COPY[tier].label
}

export function trustExplanation(tier: TrustTier): string {
  return TRUST_COPY[tier].explanation
}

/** Low reliability as its owner reads it: what it costs, and what moves it. */
const OWN_LOW_RELIABILITY =
  'Counterparties are warned before trading with you until it rises. Settled trades with independent wallets raise it; trading in loops or walking away from agreed deals lowers it.'

/** The same labels explained to the wallet's owner (Contacts' "Your reliability"), never as a risk of their own address. */
const OWN_EXPLANATION: Record<TrustTier, string> = {
  'High Authenticity': 'Counterparties see settled trades with many independent wallets, and nothing unusual.',
  'Low Reliability': OWN_LOW_RELIABILITY,
  'Ring Anomaly Detected': OWN_LOW_RELIABILITY,
  Unverified: 'Your wallet has no settled trades yet, so it has no score. Each settled trade builds it.',
}

export function ownTrustExplanation(tier: TrustTier): string {
  return OWN_EXPLANATION[tier]
}

export interface RiskWarning {
  title: string
  body: string
  /** A trading loop: said louder than a thin history. */
  severe: boolean
}

/** Every tier but High Authenticity is a risk the user confirms before trading (accept_risk). */
const CONSENT_COPY: Partial<Record<TrustTier, { title: string; body: (name: string) => string; severe?: boolean }>> = {
  'Low Reliability': { title: 'Low reliability', body: (name) => `${name} has little reliable trade history. Trading with it is a risk.` },
  Unverified: { title: 'No history yet', body: (name) => `${name} has no settled trades yet. Trading with it is a risk.` },
  'Ring Anomaly Detected': {
    title: 'Suspicious activity',
    body: (name) => `${name} trades in loops with itself, a pattern used to fake reliability. Trading with it is a high risk.`,
    severe: true,
  },
}

/** The warning to confirm before trading with this tier (accept_risk), or null when none is needed. */
export function riskConsent(tier: TrustTier, name: string): RiskWarning | null {
  const copy = CONSENT_COPY[tier]
  return copy ? { title: copy.title, body: copy.body(name), severe: copy.severe ?? false } : null
}

/** A text from the backend (e.g. a gate reason) with each tier name in the UI's words. */
export function withTrustLabels(text: string): string {
  return (Object.keys(TRUST_COPY) as TrustTier[]).reduce((out, tier) => out.replaceAll(tier, trustLabel(tier)), text)
}
