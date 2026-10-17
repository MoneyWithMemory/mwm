import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { useState } from 'react'
import type { WalletId } from '@/api'
import { OverlayLayer } from '@/components/ui/OverlayLayer'
import { ToastProvider } from '@/components/ui/Toast'
import { cn } from '@/lib/cn'
import { DEMO_WALLETS } from '@/lib/demo-wallets'
import { MOTION_CONFIG, fade } from '@/lib/motion'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { SplitView } from '@/views'
import { HealthDot } from './HealthDot'
import { SplitToggle, type Layout } from './SplitToggle'
import { WalletPane } from './WalletPane'
import { WalletSwitcher } from './WalletSwitcher'

/** Split needs two usable columns; below this width the app stays single. */
const SPLIT_QUERY = '(min-width: 1024px)'

/**
 * Telegram Wallet style shell: one wallet pane in a phone-width column, or
 * Wallet A | Wallet B side by side on wide screens.
 */
export function AppShell() {
  const [layout, setLayout] = useState<Layout>('single')
  const [walletId, setWalletId] = useState<WalletId>(DEMO_WALLETS[0].id)
  const wide = useMediaQuery(SPLIT_QUERY)
  const effective: Layout = wide ? layout : 'single'

  return (
    <MotionConfig reducedMotion={MOTION_CONFIG.reducedMotion}>
      <OverlayLayer className="ui-shell flex h-dvh flex-col bg-bg pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
        <ToastProvider>
          <div className={cn('mx-auto flex min-h-0 w-full flex-1 flex-col', effective === 'split' ? 'max-w-6xl' : 'max-w-[480px]')}>
            <header className="flex items-center gap-2 px-3 py-2">
              {effective === 'single' ? (
                <WalletSwitcher walletId={walletId} onSelect={setWalletId} />
              ) : (
                <span className="badge-nowrap px-1.5 text-sm font-semibold">MwM Wallet</span>
              )}
              <div className="ml-auto flex items-center gap-2">
                <HealthDot />
                {wide && <SplitToggle layout={layout} onToggle={() => setLayout(layout === 'split' ? 'single' : 'split')} />}
              </div>
            </header>

            <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface sm:mb-3 sm:rounded-card sm:shadow-card">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={effective === 'split' ? 'split' : walletId}
                  variants={fade}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="flex min-h-0 flex-1 flex-col"
                >
                  {effective === 'split' ? <SplitView /> : <WalletPane walletId={walletId} />}
                </motion.div>
              </AnimatePresence>
            </main>
          </div>
        </ToastProvider>
      </OverlayLayer>
    </MotionConfig>
  )
}
