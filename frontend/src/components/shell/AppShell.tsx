import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { useState } from 'react'
import type { WalletId } from '@/api'
import mwmLogo from '@/assets/mwm-mark-white.svg'
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
 * Dark wallet shell. Phone and half-screen widths: one pane in a single column with the
 * bottom tab bar. From 1024px: a discreet top bar, and either one pane with a sidebar
 * (single view) or Wallet A | Wallet B, each pane with its own tab bar (split view).
 */
export function AppShell() {
  const [layout, setLayout] = useState<Layout>('single')
  const [walletId, setWalletId] = useState<WalletId>(DEMO_WALLETS[0].id)
  const wide = useMediaQuery(SPLIT_QUERY)
  const split = wide && layout === 'split'

  return (
    <MotionConfig reducedMotion={MOTION_CONFIG.reducedMotion}>
      <OverlayLayer className="ui-shell app-backdrop flex h-dvh flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
        <ToastProvider>
          <div
            className={cn(
              'mx-auto flex min-h-0 w-full flex-1 flex-col',
              split
                ? 'max-w-[872px] px-4'
                : wide
                  ? 'max-w-[1440px] px-4 xl:px-6 2xl:px-8'
                  : 'max-w-[480px]',
            )}
          >
            <header className={cn('flex items-center gap-3 py-2', wide ? 'h-14' : 'px-3')}>
              <img
                src={mwmLogo}
                alt="MwM Wallet"
                className="h-[26px] w-auto shrink-0 select-none object-contain"
                loading="eager"
                decoding="async"
              />
              {wide && !split && <span className="h-4 w-px shrink-0 bg-separator" aria-hidden="true" />}
              {!split && <WalletSwitcher walletId={walletId} onSelect={setWalletId} />}
              <div className="ml-auto flex items-center gap-2">
                <HealthDot />
                {wide && <SplitToggle layout={layout} onToggle={() => setLayout(split ? 'single' : 'split')} />}
              </div>
            </header>

            <main className={cn('flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden', wide && 'pb-4')}>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={split ? 'split' : walletId}
                  variants={fade}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="flex min-h-0 min-w-0 flex-1 flex-col"
                >
                  {split ? <SplitView /> : <WalletPane walletId={walletId} nav={wide ? 'side' : 'bottom'} />}
                </motion.div>
              </AnimatePresence>
            </main>
          </div>
        </ToastProvider>
      </OverlayLayer>
    </MotionConfig>
  )
}
