import { UserPlus } from 'lucide-react'
import { useState } from 'react'
import { useContacts } from '@/api'
import { Button, EmptyState, ErrorState, Skeleton } from '@/components/ui'
import { useWalletContext } from '@/lib/navigation'
import { AddContactSheet } from './AddContactSheet'
import { ContactRow } from './ContactRow'
import { ContactSheet } from './ContactSheet'
import { ProfileCard } from './ProfileCard'

function ContactsSkeleton() {
  return (
    <div className="flex flex-col gap-2" role="status" aria-label="Loading contacts">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-[76px] rounded-card" />
      ))}
    </div>
  )
}

export function ContactsView() {
  const { walletId, navigate } = useWalletContext()
  const contacts = useContacts(walletId)
  const [addOpen, setAddOpen] = useState(false)
  const [selected, setSelected] = useState<{ address: string; open: boolean } | null>(null)

  const list = contacts.data
  const current = list?.find((c) => c.address === selected?.address)
  const trade = (address: string) => navigate('trade', { counterpartyId: address })

  let body
  if (list && list.length > 0) {
    body = (
      <ul className="flex flex-col divide-y divide-separator rounded-card bg-surface shadow-card">
        {list.map((contact) => (
          <ContactRow
            key={contact.address}
            contact={contact}
            onOpen={() => setSelected({ address: contact.address, open: true })}
            onTrade={() => trade(contact.address)}
          />
        ))}
      </ul>
    )
  } else if (list) {
    body = (
      <EmptyState
        className="rounded-card bg-surface shadow-card"
        title="No contacts yet"
        description="Counterparties appear here after your first trade or when you add one."
      />
    )
  } else if (contacts.error) {
    body = (
      <ErrorState
        title="Couldn't load contacts"
        message="Check your connection and try again."
        onRetry={contacts.refresh}
      />
    )
  } else {
    body = <ContactsSkeleton />
  }

  return (
    <div className="flex flex-col justify-start gap-4 p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-lg font-semibold">Contacts</h1>
          <p className="text-sm text-hint">No-KYC address book</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>
          <UserPlus size={16} aria-hidden="true" />
          Add
        </Button>
      </header>
      <ProfileCard walletId={walletId} />
      {body}
      <AddContactSheet open={addOpen} onClose={() => setAddOpen(false)} />
      {current && selected && (
        <ContactSheet
          contact={current}
          open={selected.open}
          walletId={walletId}
          onClose={() => setSelected({ ...selected, open: false })}
          onTrade={() => trade(current.address)}
        />
      )}
    </div>
  )
}
