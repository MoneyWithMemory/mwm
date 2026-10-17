import { CheckCircle2, Clock, FileCheck2, ShieldCheck, XCircle } from 'lucide-react'
import { useState } from 'react'
import type { CanonicalSwapTerms, Role } from '@/api/types'
import { cn } from '@/lib/cn'
import { formatSats, formatUsd, shortAddress } from '@/lib/format'
import { AssetBadge } from './AssetBadge'
import { Button } from './Button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './Card'
import { Checkbox } from './Checkbox'
import { CopyButton } from './CopyButton'

export interface ApprovalCardProps {
  terms: CanonicalSwapTerms
  termsHash?: string | null
  assetTicker?: string
  paymentTicker?: string
  myRole: Role
  mySigned: boolean
  counterpartySigned: boolean
  signing?: boolean
  cancelling?: boolean
  onSign: () => void
  onCancel?: () => void
  className?: string
}

/**
 * P2P Trade terms review and signing approval card.
 * Enforces explicit user confirmation ("I reviewed the terms") before enabling the sign CTA.
 * Shows live signature status of the counterparty.
 */
export function ApprovalCard({
  terms,
  termsHash,
  assetTicker = 'PEPE',
  paymentTicker = 'USDT',
  myRole,
  mySigned,
  counterpartySigned,
  signing = false,
  cancelling = false,
  onSign,
  onCancel,
  className,
}: ApprovalCardProps) {
  const [reviewed, setReviewed] = useState(false)
  const otherRole: Role = myRole === 'buyer' ? 'seller' : 'buyer'
  const otherRoleLabel = otherRole === 'buyer' ? 'Buyer' : 'Seller'

  const formattedExpiry = new Date(terms.expiry_unix * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <Card className={cn('border-accent/30 shadow-raised', className)}>
      <CardHeader className="border-b border-separator/30 pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileCheck2 size={18} className="text-accent" aria-hidden="true" />
            <CardTitle className="text-sm font-semibold">Canonical Swap Terms</CardTitle>
          </div>
          <span className="text-[11px] text-hint amount">Expires at {formattedExpiry}</span>
        </div>
      </CardHeader>

      <CardContent className="pt-3 pb-3 space-y-3">
        {/* Asset trade row */}
        <div className="grid grid-cols-2 gap-2 bg-surface-muted/60 p-3 rounded-control text-xs">
          <div>
            <span className="text-hint text-[11px] block mb-1">Asset To Receive</span>
            <div className="flex items-center gap-1.5 font-semibold text-fg">
              <AssetBadge
                ticker={myRole === 'buyer' ? assetTicker : paymentTicker}
                asset_id={myRole === 'buyer' ? terms.asset_id : terms.payment_asset_id}
                size="sm"
              />
              <span className="amount">
                {myRole === 'buyer'
                  ? `${terms.rgb_amount.toLocaleString()} ${assetTicker}`
                  : `${terms.payment_amount.toLocaleString()} ${paymentTicker}`}
              </span>
            </div>
          </div>

          <div>
            <span className="text-hint text-[11px] block mb-1">Payment To Send</span>
            <div className="flex items-center gap-1.5 font-semibold text-fg">
              <AssetBadge
                ticker={myRole === 'buyer' ? paymentTicker : assetTicker}
                asset_id={myRole === 'buyer' ? terms.payment_asset_id : terms.asset_id}
                size="sm"
              />
              <span className="amount">
                {myRole === 'buyer'
                  ? `${terms.payment_amount.toLocaleString()} ${paymentTicker}`
                  : `${terms.rgb_amount.toLocaleString()} ${assetTicker}`}
              </span>
            </div>
          </div>
        </div>

        {/* Pricing & Fee breakdown */}
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-hint">Agreed Price</span>
            <span className="font-semibold text-fg amount">{formatUsd(terms.agreed_price_usd)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-hint">Network Fee (sats)</span>
            <span className="font-mono text-fg text-[11px] amount">{formatSats(terms.network_fee_sat)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-hint">Counterparty Address</span>
            <span className="font-mono text-fg text-[11px] select-text">
              {shortAddress(myRole === 'buyer' ? terms.seller_address : terms.buyer_address)}
            </span>
          </div>
          {termsHash && (
            <div className="flex items-center justify-between pt-1 border-t border-separator/20">
              <span className="text-hint flex items-center gap-1 text-[11px]">
                <ShieldCheck size={12} className="text-accent" aria-hidden="true" />
                <span>Terms Hash</span>
              </span>
              <div className="flex items-center gap-1">
                <code className="text-[10px] font-mono text-hint select-text">
                  {shortAddress(termsHash, 8, 6)}
                </code>
                <CopyButton text={termsHash} size="sm" />
              </div>
            </div>
          )}
        </div>

        {/* Counterparty signing status pill */}
        <div className="flex items-center justify-between p-2 rounded-control bg-surface-muted/40 border border-separator/20 text-xs">
          <span className="text-hint">{otherRoleLabel} Signature:</span>
          {counterpartySigned ? (
            <span className="badge-nowrap inline-flex items-center gap-1 text-success font-medium">
              <CheckCircle2 size={13} aria-hidden="true" />
              <span>Signed</span>
            </span>
          ) : (
            <span className="badge-nowrap inline-flex items-center gap-1 text-warning font-medium">
              <Clock size={13} className="animate-pulse" aria-hidden="true" />
              <span>Waiting for {otherRoleLabel}…</span>
            </span>
          )}
        </div>

        {/* Review confirmation checkbox */}
        {!mySigned && (
          <div className="pt-1">
            <Checkbox
              id="review-terms"
              checked={reviewed}
              onChange={setReviewed}
              label="I reviewed the canonical terms and agree to sign."
              description="Signatures are cryptographically binding on Bitcoin regtest."
            />
          </div>
        )}
      </CardContent>

      <CardFooter className="flex-col gap-2 pt-3">
        {mySigned ? (
          <div className="w-full flex items-center justify-center gap-2 p-2.5 rounded-control bg-success/15 text-success text-xs font-semibold">
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>You have signed these terms. Waiting for atomic settlement.</span>
          </div>
        ) : (
          <Button
            variant="primary"
            size="md"
            fullWidth
            disabled={!reviewed}
            loading={signing}
            onClick={onSign}
          >
            Approve & Sign
          </Button>
        )}

        {onCancel && (
          <Button
            variant="ghost"
            size="sm"
            fullWidth
            disabled={signing}
            loading={cancelling}
            onClick={onCancel}
            className="text-hint hover:text-danger"
          >
            <XCircle size={14} className="mr-1" aria-hidden="true" />
            <span>Cancel Session</span>
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
