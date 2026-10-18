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

/** Low reliability as its owner reads it: what it blocks, and what moves it. */
const OWN_LOW_RELIABILITY =
  "Your agents can't trade until it rises. Settled trades with independent wallets raise it; trading in loops or walking away from agreed deals lowers it."

/** The same labels explained to the wallet's owner (Contacts' "Your reliability"), never as a risk of their own address. */
const OWN_EXPLANATION: Record<TrustTier, string> = {
  'High Authenticity': 'Counterparties see settled trades with many independent wallets, and nothing unusual.',
  'Low Reliability': OWN_LOW_RELIABILITY,
  'Ring Anomaly Detected': OWN_LOW_RELIABILITY,
  Unverified: 'Your wallet has no settled trades yet, so it has no score. Agents trade only with reliable wallets.',
}

export function ownTrustExplanation(tier: TrustTier): string {
  return OWN_EXPLANATION[tier]
}

/** A text from the backend (e.g. a gate reason) with each tier name in the UI's words. */
export function withTrustLabels(text: string): string {
  return (Object.keys(TRUST_COPY) as TrustTier[]).reduce((out, tier) => out.replaceAll(tier, trustLabel(tier)), text)
}
