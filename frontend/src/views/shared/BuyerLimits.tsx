import { FormNote, NumberField, PrivacyTag } from '@/components/ui'

interface BuyerLimitsProps {
  target: string
  ceiling: string
  onTarget: (text: string) => void
  onCeiling: (text: string) => void
  targetError?: string
  ceilingError?: string
  /** Errors show once the form has been touched. */
  show: boolean
}

/** Target and maximum side by side, low to high, in whole dollars, with one line for errors or the rule. */
export function BuyerLimits({ target, ceiling, onTarget, onCeiling, targetError, ceilingError, show }: BuyerLimitsProps) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">Your limits</h3>
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Target"
          placeholder="0"
          prefix="$"
          inputMode="numeric"
          value={target}
          invalid={show && Boolean(targetError)}
          onChange={(e) => onTarget(e.target.value)}
        />
        <NumberField
          label="Maximum"
          aside={<PrivacyTag kind="private" />}
          placeholder="0"
          prefix="$"
          inputMode="numeric"
          value={ceiling}
          invalid={show && Boolean(ceilingError)}
          onChange={(e) => onCeiling(e.target.value)}
        />
      </div>
      <FormNote error={show ? (targetError ?? ceilingError) : undefined}>
        Your agent opens near the target and never pays above the maximum.
      </FormNote>
    </div>
  )
}
