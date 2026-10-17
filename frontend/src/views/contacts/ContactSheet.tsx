import { useState } from 'react'
import type { Contact } from '@/api'
import { Avatar, Button, CopyButton, Sheet, TrustBadge } from '@/components/ui'
import { formatAssetAmount, formatUsd, shortAddress } from '@/lib/format'
import { RenameSheet } from '../shared/RenameSheet'
import { reliabilityText } from './reliability'

interface ContactSheetProps {
  contact: Contact
  open: boolean
  walletId: string
  onClose: () => void
  onTrade: () => void
}

export function ContactSheet({ contact, open, walletId, onClose, onTrade }: ContactSheetProps) {
  const [renameOpen, setRenameOpen] = useState(false)
  const name = contact.alias ?? shortAddress(contact.address)
  const desk = contact.desk

  return (
    <>
      <Sheet open={open} onClose={onClose} title="Contact">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Avatar seed={contact.address} label={contact.alias ?? undefined} size="lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate text-base font-semibold">{name}</span>
              <TrustBadge tier={contact.trust.trust_tier} size="sm" className="self-start" />
            </div>
            <span className="amount badge-nowrap text-sm font-semibold">{reliabilityText(contact)}</span>
          </div>

          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-hint">Assessment</h3>
            <p className="select-text text-sm leading-relaxed">{contact.trust.assessment_summary}</p>
          </section>

          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-hint">Address</h3>
            <div className="flex items-center gap-2 rounded-control bg-surface-muted py-1.5 pr-1.5 pl-3">
              <span className="select-text min-w-0 flex-1 break-all font-mono text-xs">{contact.address}</span>
              <CopyButton text={contact.address} size="md" />
            </div>
          </section>

          {desk && (
            <section className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-hint">Selling</h3>
              <p className="amount text-sm">
                {formatAssetAmount(desk.offered_amount, desk.asset.precision, desk.asset.ticker)} for{' '}
                {formatUsd(desk.asking_price_usd)}
              </p>
            </section>
          )}

          <div className="flex gap-2">
            <Button variant="secondary" fullWidth onClick={() => setRenameOpen(true)}>
              Rename
            </Button>
            <Button fullWidth trailingArrow onClick={onTrade}>
              Trade
            </Button>
          </div>
        </div>
      </Sheet>
      <RenameSheet
        key={contact.address}
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        walletId={walletId}
        address={contact.address}
        currentName={contact.alias ?? ''}
      />
    </>
  )
}
