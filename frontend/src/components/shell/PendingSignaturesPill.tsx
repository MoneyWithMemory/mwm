import { PenLine } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { usePendingSignatures, useWallets, type WalletId } from '@/api'
import { dropdown } from '@/lib/motion'
import { openSessionInPane } from '@/lib/paneStacks'

interface PendingSignaturesPillProps {
  /** The wallet on screen: its own pending deals already show as a badge on Deals. */
  activeWalletId: WalletId
  onSwitch: (walletId: WalletId) => void
}

/**
 * Header prompt when another wallet has terms waiting for its signature. One tap switches to
 * that wallet with the deal already open, so the counterparty can sign without hunting for it.
 */
export function PendingSignaturesPill({ activeWalletId, onSwitch }: PendingSignaturesPillProps) {
  const wallets = useWallets()
  const ids = (wallets.data ?? []).map((w) => w.wallet_id)
  const pending = usePendingSignatures(ids)
  const others = (pending.data ?? []).filter((p) => p.walletId !== activeWalletId)
  const first = others[0]
  const label = first ? (wallets.data?.find((w) => w.wallet_id === first.walletId)?.label ?? first.walletId) : ''

  const open = () => {
    if (!first) return
    openSessionInPane(first.walletId, first.session.session_id)
    onSwitch(first.walletId)
  }

  return (
    <AnimatePresence initial={false}>
      {first && (
        <motion.button
          key="pending-signatures"
          type="button"
          variants={dropdown}
          initial="initial"
          animate="animate"
          exit="exit"
          onClick={open}
          aria-label={`${label} has terms to sign: open the deal`}
          className="pressable badge-nowrap flex min-w-0 origin-right items-center gap-1.5 rounded-full bg-warning/15 px-3 py-1.5 text-xs font-medium text-warning"
        >
          <PenLine size={14} className="shrink-0" aria-hidden="true" />
          <span className="truncate">
            {label} · to sign{others.length > 1 ? ` (${others.length})` : ''}
          </span>
        </motion.button>
      )}
    </AnimatePresence>
  )
}
