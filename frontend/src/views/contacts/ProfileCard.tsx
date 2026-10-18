import { useWallet } from '@/api'
import { Avatar, Card, CopyButton, Skeleton, TrustBadge } from '@/components/ui'
import { shortAddress } from '@/lib/format'
import { ownTrustExplanation } from '@/lib/trust'

/**
 * The wallet itself, first in Contacts: its reliability as counterparties see it (the one loud
 * number), what the label means for its owner behind the (?), and the address to share.
 */
export function ProfileCard({ walletId }: { walletId: string }) {
  const wallet = useWallet(walletId)
  const data = wallet.data

  if (!data) {
    return (
      <Card className="flex flex-col gap-4 p-4" role="status" aria-label="Loading your profile">
        <div className="flex items-center gap-3">
          <Skeleton variant="circular" className="size-11" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton width={96} height={14} />
            <Skeleton width={120} height={12} />
          </div>
        </div>
        <div className="flex items-end justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <Skeleton width={88} height={12} />
            <Skeleton width={64} height={24} />
          </div>
          <Skeleton width={128} height={22} className="rounded-full" />
        </div>
      </Card>
    )
  }

  const trust = data.trust
  const pct = trust?.reliability_pct ?? null

  return (
    <Card className="flex flex-col gap-4 p-4" aria-label="Your profile">
      <div className="flex items-center gap-3">
        <Avatar seed={data.address} label={data.label} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{data.label}</span>
          <span className="amount truncate text-xs text-hint">{shortAddress(data.address)}</span>
        </div>
        <CopyButton text={data.address} />
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-hint">Your reliability</span>
          <span className="amount text-2xl leading-none font-semibold">{pct === null ? '—' : `${Math.round(pct)}%`}</span>
        </div>
        {trust ? (
          <TrustBadge tier={trust.trust_tier} size="sm" explain explanation={ownTrustExplanation(trust.trust_tier)} />
        ) : (
          <span className="text-xs text-hint">Not available yet</span>
        )}
      </div>
    </Card>
  )
}
