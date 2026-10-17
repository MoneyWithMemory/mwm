import { useState } from 'react'
import type { LimitTexts } from '@/lib/lots'

/**
 * Target and maximum as the buyer typed them or, until either is edited, the suggestion for the
 * current amount (else the saved defaults). Editing one keeps the other where it was shown.
 */
export function useBuyerLimits(defaults: LimitTexts, suggested: LimitTexts | null) {
  const [typed, setTyped] = useState<LimitTexts | null>(null)
  const shown = typed ?? suggested ?? defaults
  const edit = (field: keyof LimitTexts) => (text: string) => setTyped({ ...shown, [field]: text })
  return { ...shown, onTarget: edit('target'), onCeiling: edit('ceiling') }
}
