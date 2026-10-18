import type { TrustTier } from '@/api'
import { Button, Sheet, TrustBadge } from '@/components/ui'
import { riskConsent } from '@/lib/trust'
import { cn } from '@/lib/cn'

export interface RiskToConfirm {
  tier: TrustTier
  reliabilityPct: number | null
  name: string
}

interface RiskConfirmSheetProps {
  open: boolean
  /** Kept while the sheet closes, so its words do not change on the way out. */
  risk: RiskToConfirm | null
  pending?: boolean
  onCancel: () => void
  onContinue: () => void
}

/**
 * Asked before trading with a counterparty that is not High Authenticity (accept_risk): the user
 * decides. Cancel is the loud, safe default; "Continue anyway" stays secondary.
 */
export function RiskConfirmSheet({ open, risk, pending = false, onCancel, onContinue }: RiskConfirmSheetProps) {
  const copy = risk ? riskConsent(risk.tier, risk.name) : null
  return (
    <Sheet open={open} onClose={onCancel} title={copy?.title ?? 'Low reliability'}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col items-start gap-2">
          <p className={cn('text-sm', copy?.severe ? 'text-danger' : 'text-hint')}>{copy?.body}</p>
          {risk && <TrustBadge tier={risk.tier} reliabilityPct={risk.reliabilityPct} explain />}
        </div>
        <div className="flex flex-col gap-2">
          <Button fullWidth onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="secondary" fullWidth loading={pending} onClick={onContinue}>
            Continue anyway
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
