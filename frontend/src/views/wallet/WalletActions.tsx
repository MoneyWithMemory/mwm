import { ArrowLeftRight, QrCode, Store, type LucideIcon } from 'lucide-react'
import { IconButton } from '@/components/ui'

interface WalletActionsProps {
  onReceive: () => void
  onTrade: () => void
  onSellerDesk: () => void
}

function Action({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <IconButton variant="primary" size="lg" aria-label={label} onClick={onClick}>
        <Icon size={20} aria-hidden="true" />
      </IconButton>
      <span className="badge-nowrap text-xs font-medium">{label}</span>
    </div>
  )
}

export function WalletActions({ onReceive, onTrade, onSellerDesk }: WalletActionsProps) {
  return (
    <div className="flex justify-around">
      <Action icon={QrCode} label="Receive" onClick={onReceive} />
      <Action icon={ArrowLeftRight} label="P2P Trade" onClick={onTrade} />
      <Action icon={Store} label="Seller Desk" onClick={onSellerDesk} />
    </div>
  )
}
