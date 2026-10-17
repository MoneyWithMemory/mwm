import { ArrowDownLeft, ArrowUpRight, Pencil } from 'lucide-react'
import type { ActivityItem } from '@/api'
import { cn } from '@/lib/cn'
import { shortAddress } from '@/lib/format'
import { StateMessage } from './StateMessage'
import { formatBalance } from './valuation'

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

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

export function ActivityList({ items, aliases, onRename }: ActivityListProps) {
  return (
    <section className="flex flex-col gap-2" aria-label="Transactions">
      <h2 className="px-1 text-sm font-semibold text-hint">Transactions</h2>
      {items.length === 0 ? (
        <StateMessage title="No transactions yet" body="Your activity will show up here once you receive or trade." />
      ) : (
        <ul className="flex flex-col divide-y divide-separator rounded-card bg-surface shadow-card">
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
                      <button
                        type="button"
                        className="pressable-icon pressable-flat -m-1 shrink-0 rounded-full p-1"
                        onClick={() => onRename(address)}
                        aria-label={`Rename ${name}`}
                      >
                        <Pencil size={13} aria-hidden="true" />
                      </button>
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
      )}
    </section>
  )
}
