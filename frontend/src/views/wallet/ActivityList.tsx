import { ArrowDownLeft, ArrowUpRight, Pencil } from 'lucide-react'
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
}

interface ActivityListProps {
  items: ActivityItem[]
  aliases: Record<string, string>
  onRename: (address: string) => void
}

interface ActivityRowsProps extends ActivityListProps {
  className?: string
}

function ActivityRows({ items, aliases, onRename, className }: ActivityRowsProps) {
  return (
    <ul className={cn('flex flex-col divide-y divide-separator', className)}>
      {items.map((item) => {
        const incoming = item.direction === 'in'
        const address = item.counterparty_address
        const name = address ? (aliases[address] ?? shortAddress(address)) : KIND_LABEL[item.kind]
        return (
          <li key={item.id} className="flex items-center gap-3 p-3">
            <span
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-muted',
                incoming ? 'text-success' : 'text-hint',
              )}
              aria-hidden="true"
            >
              {incoming ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-semibold">{incoming ? 'Received' : 'Sent'}</span>
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

export function ActivityList({ items, aliases, onRename }: ActivityListProps) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const hasMore = items.length > PREVIEW_COUNT

  return (
    <section className="flex flex-col gap-2" aria-label="Transactions">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold text-hint">Transactions</h2>
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
        />
      )}

      <Sheet open={historyOpen} onClose={() => setHistoryOpen(false)} title="All transactions">
        <ActivityRows items={items} aliases={aliases} onRename={onRename} className="-mx-3" />
      </Sheet>
    </section>
  )
}
