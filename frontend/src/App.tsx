import { lazy, Suspense } from 'react'
import { AppShell } from '@/components/shell/AppShell'
import { OverlayLayer } from '@/components/ui/OverlayLayer'
import { ToastProvider } from '@/components/ui/Toast'

// Dev-only UI kit playground at /#ui; never part of the production bundle.
const UiPlayground = import.meta.env.DEV
  ? lazy(() => import('@/components/ui/__playground').then((m) => ({ default: m.UiPlayground })))
  : null

// Dev-only Tether WDK browser check at /#wdk.
const WdkSpike = import.meta.env.DEV ? lazy(() => import('@/wdk/__spike').then((m) => ({ default: m.WdkSpike }))) : null

export default function App() {
  if (WdkSpike && typeof window !== 'undefined' && window.location.hash === '#wdk') {
    return (
      <div className="ui-shell min-h-dvh bg-bg">
        <Suspense fallback={null}>
          <WdkSpike />
        </Suspense>
      </div>
    )
  }
  if (UiPlayground && typeof window !== 'undefined' && window.location.hash === '#ui') {
    return (
      <OverlayLayer className="ui-shell min-h-dvh bg-bg">
        <ToastProvider>
          <Suspense fallback={null}>
            <UiPlayground />
          </Suspense>
        </ToastProvider>
      </OverlayLayer>
    )
  }
  return <AppShell />
}
