import { ArrowDownLeft, ArrowUpRight, Lock, Pencil } from 'lucide-react'
import { useState } from 'react'
import type { ActivityItem } from '@/api'
import { Button, EmptyState, IconButton, Sheet } from '@/components/ui'
import { cn } from '@/lib/cn'
import { shortAddress } from '@/lib/format'
import { formatBalance } from './valuation'

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

/** Rows shown inline; the full history opens in a sheet. */
const PREVIEW_COUNT = 5

const KIND_LABEL: Record<ActivityItem['kind'], string> = {
  swap: 'Swap',
  receive: 'Deposit',
  issue: 'Issuance',
  vault: 'Vault',
}

/** Which part of the account the list belongs to: a Vault move is "in" for one and "out" for the other. */
export type ActivityPerspective = 'wallet' | 'vault'

/** Title, counterparty line and direction of a row, as seen from `perspective`. */
function describe(item: ActivityItem, perspective: ActivityPerspective, aliases: Record<string, string>) {
  if (item.kind === 'vault') {
    // direction is the wallet's: "out" went to the Vault.
    const toVault = item.direction === 'out'
    if (perspective === 'vault') return { title: toVault ? 'From Wallet' : 'Moved to Wallet', name: 'Your Wallet', incoming: toVault }
    return { title: toVault ? 'Moved to Vault' : 'From Vault', name: 'Your Vault', incoming: !toVault }
  }
  const incoming = item.direction === 'in'
  const address = item.counterparty_address
  return {
    title: incoming ? 'Received' : 'Sent',
    name: address ? (aliases[address] ?? shortAddress(address)) : KIND_LABEL[item.kind],
    incoming,
  }
}

interface ActivityListProps {
  items: ActivityItem[]
  aliases: Record<string, string>
  onRename: (address: string) => void
  /** Default "Transactions". */
  title?: string
  /** Default "wallet". */
  perspective?: ActivityPerspective
}

interface ActivityRowsProps extends Omit<ActivityListProps, 'title'> {
  className?: string
}

function ActivityRows({ items, aliases, onRename, perspective = 'wallet', className }: ActivityRowsProps) {
  return (
    <ul className={cn('flex flex-col divide-y divide-separator', className)}>
      {items.map((item) => {
        const { title, name, incoming } = describe(item, perspective, aliases)
        const address = item.counterparty_address
        return (
          <li key={item.id} className="flex items-center gap-3 p-3">
            <span
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-full',
                item.kind === 'vault' ? 'bg-accent/15 text-accent' : 'bg-surface-muted',
                item.kind !== 'vault' && (incoming ? 'text-success' : 'text-hint'),
              )}
              aria-hidden="true"
            >
              {item.kind === 'vault' ? <Lock size={16} /> : incoming ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-semibold">{title}</span>
              <span className="flex items-center gap-1 text-xs text-hint">
                <span className="select-text truncate">{name}</span>
                {address && (
                  <IconButton size="sm" aria-label={`Rename ${name}`} onClick={() => onRename(address)}>
                    <Pencil size={13} aria-hidden="true" />
                  </IconButton>
                )}
              </span>
            </div>
            <div className="flex flex-col items-end">
              <span className={cn('amount text-sm font-semibold', incoming && 'text-success')}>
                {incoming ? '+' : '−'}
                {formatBalance(item.asset, item.amount)}
              </span>
              <span className="badge-nowrap text-xs text-hint">
                {item.status === 'pending' ? 'Pending' : 'Confirmed'} · {dateFormat.format(new Date(item.t * 1000))}
              </span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function ActivityList({ items, aliases, onRename, title = 'Transactions', perspective = 'wallet' }: ActivityListProps) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const hasMore = items.length > PREVIEW_COUNT

  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <div className="flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold text-hint">{title}</h2>
        {hasMore && (
          <Button variant="ghost" size="sm" trailingArrow onClick={() => setHistoryOpen(true)}>
            See all
          </Button>
        )}
      </div>

      {items.length === 0 ? (
        <EmptyState
          className="rounded-card bg-surface shadow-card"
          title="No transactions yet"
          description="Your activity will show up here once you receive or trade."
        />
      ) : (
        <ActivityRows
          className="rounded-card bg-surface shadow-card"
          items={items.slice(0, PREVIEW_COUNT)}
          aliases={aliases}
          onRename={onRename}
          perspective={perspective}
        />
      )}

      <Sheet open={historyOpen} onClose={() => setHistoryOpen(false)} title={`All ${title.toLowerCase()}`}>
        <ActivityRows items={items} aliases={aliases} onRename={onRename} perspective={perspective} className="-mx-3" />
      </Sheet>
    </section>
  )
}
