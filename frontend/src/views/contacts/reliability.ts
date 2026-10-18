import type { Contact } from '@/api'

/** "Reliability 92%", or "Unverified" while there is no score. Never loop percentages or counts. */
export function reliabilityText(contact: Contact): string {
  const pct = contact.trust.reliability_pct
  return pct === null ? 'Unverified' : `Reliability ${Math.round(pct)}%`
}
