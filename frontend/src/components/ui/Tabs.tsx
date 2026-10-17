import { motion } from 'motion/react'
import { useId, type ComponentType, type KeyboardEvent } from 'react'
import { cn } from '@/lib/cn'
import { SPRING_TABS } from '@/lib/motion'

export interface TabItem<T extends string = string> {
  id: T
  label: string
  icon?: ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
  badge?: string | number
  disabled?: boolean
}

export interface TabsProps<T extends string = string> {
  tabs: TabItem<T>[]
  activeId: T
  onChange: (id: T) => void
  layoutId?: string
  size?: 'sm' | 'md'
  fullWidth?: boolean
  className?: string
}

export function Tabs<T extends string = string>({
  tabs,
  activeId,
  onChange,
  layoutId,
  size = 'md',
  fullWidth = false,
  className,
}: TabsProps<T>) {
  const autoLayoutId = useId()
  const activeLayoutId = layoutId ?? `tabs-${autoLayoutId}`

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabledTabs = tabs.filter((t) => !t.disabled)
    const currentIndex = enabledTabs.findIndex((t) => t.id === activeId)
    if (currentIndex === -1) return

    let nextIndex = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % enabledTabs.length
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + enabledTabs.length) % enabledTabs.length
    } else if (e.key === 'Home') {
      nextIndex = 0
    } else if (e.key === 'End') {
      nextIndex = enabledTabs.length - 1
    }

    if (nextIndex !== -1) {
      e.preventDefault()
      onChange(enabledTabs[nextIndex].id)
    }
  }

  return (
    <div
      role="tablist"
      onKeyDown={handleKeyDown}
      className={cn(
        'relative inline-flex items-center bg-surface-muted p-1 rounded-control select-none gap-1',
        fullWidth && 'w-full',
        className
      )}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId
        const Icon = tab.icon

        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className={cn(
              'relative z-10 inline-flex items-center justify-center font-medium transition-colors duration-quick ease-smooth-out outline-none',
              fullWidth ? 'flex-1' : 'shrink-0',
              size === 'sm' ? 'px-2.5 py-1 text-xs gap-1.5' : 'px-3.5 py-1.5 text-sm gap-2',
              isActive ? 'text-fg font-semibold' : 'text-hint hover:text-fg',
              tab.disabled && 'opacity-40 cursor-not-allowed pointer-events-none'
            )}
          >
            {isActive && (
              <motion.span
                layoutId={activeLayoutId}
                transition={SPRING_TABS}
                className="absolute inset-0 bg-surface-raised rounded-[calc(var(--radius-control)-4px)] shadow-card -z-10"
                aria-hidden="true"
              />
            )}
            {Icon && (
              <Icon
                size={size === 'sm' ? 13 : 15}
                aria-hidden={true}
                className={cn('shrink-0', isActive ? 'text-accent' : 'text-hint')}
              />
            )}
            <span>{tab.label}</span>
            {tab.badge !== undefined && (
              <span
                className={cn(
                  'badge-nowrap rounded-full px-1.5 py-0.2 text-[10px] font-semibold leading-none',
                  isActive ? 'bg-accent/15 text-accent' : 'bg-surface-muted text-hint'
                )}
              >
                {tab.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
