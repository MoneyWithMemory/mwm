import type { TrustTier } from '@/api/types'

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
  'Ring Anomaly Detected': {
    label: 'Low reliability',
    explanation:
      'The system detected unusual behavior, such as trading in loops, repeated transfers or attempted scams. Trading with this address is a risk.',
  },
  Unverified: {
    label: 'Unverified',
    explanation: 'Not enough trade history yet to score this address.',
  },
}

/** "Low reliability" for "Ring Anomaly Detected". */
export function trustLabel(tier: TrustTier): string {
  return TRUST_COPY[tier].label
}

export function trustExplanation(tier: TrustTier): string {
  return TRUST_COPY[tier].explanation
}

/** A text from the backend (e.g. a gate reason) with each tier name in the UI's words. */
export function withTrustLabels(text: string): string {
  return (Object.keys(TRUST_COPY) as TrustTier[]).reduce((out, tier) => out.replaceAll(tier, trustLabel(tier)), text)
}
