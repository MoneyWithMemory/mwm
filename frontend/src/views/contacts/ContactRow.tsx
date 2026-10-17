import type { Contact } from '@/api'
import { Avatar, Button, TrustBadge } from '@/components/ui'
import { shortAddress } from '@/lib/format'
import { reliabilityText } from './reliability'

interface ContactRowProps {
  contact: Contact
  onOpen: () => void
  onTrade: () => void
}

export function ContactRow({ contact, onOpen, onTrade }: ContactRowProps) {
  const name = contact.alias ?? shortAddress(contact.address)

  return (
    <li className="flex items-center gap-2 p-3">
      <button
        type="button"
        className="pressable pressable-flat -m-1 flex min-w-0 flex-1 items-center gap-3 rounded-control p-1 text-left"
        onClick={onOpen}
        aria-label={`Open details for ${name}`}
      >
        <Avatar seed={contact.address} label={contact.alias ?? undefined} size="lg" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm font-semibold">{name}</span>
          <TrustBadge tier={contact.trust.trust_tier} size="sm" className="self-start" />
          <span className="amount text-xs text-hint">{reliabilityText(contact)}</span>
        </span>
      </button>
      <Button size="sm" variant="secondary" trailingArrow onClick={onTrade}>
        Buy
      </Button>
    </li>
  )
}
