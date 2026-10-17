import { motion } from 'motion/react'
import { useId, type ComponentType } from 'react'
import { cn } from '@/lib/cn'
import { SPRING_TABS } from '@/lib/motion'

export interface SegmentOption<T extends string = string> {
  value: T
  label: string
  icon?: ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
}

export interface SegmentedControlProps<T extends string = string> {
  options: SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  layoutId?: string
  size?: 'sm' | 'md'
  fullWidth?: boolean
  className?: string
}

export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  layoutId,
  size = 'sm',
  fullWidth = false,
  className,
}: SegmentedControlProps<T>) {
  const autoLayoutId = useId()
  const activeLayoutId = layoutId ?? `seg-${autoLayoutId}`

  return (
    <div
      role="radiogroup"
      className={cn(
        'relative inline-flex items-center bg-surface-muted p-0.5 rounded-control select-none',
        fullWidth && 'w-full',
        className
      )}
    >
      {options.map((option) => {
        const isSelected = option.value === value
        const Icon = option.icon

        return (
          <button
            key={option.value}
            role="radio"
            type="button"
            aria-checked={isSelected}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative z-10 inline-flex items-center justify-center font-medium transition-colors duration-quick ease-smooth-out outline-none text-center',
              fullWidth ? 'flex-1' : 'shrink-0',
              size === 'sm' ? 'px-2.5 py-1 text-xs gap-1.5' : 'px-3 py-1.5 text-sm gap-2',
              isSelected ? 'text-fg font-semibold' : 'text-hint hover:text-fg'
            )}
          >
            {isSelected && (
              <motion.span
                layoutId={activeLayoutId}
                transition={SPRING_TABS}
                className="absolute inset-0 bg-surface rounded-[calc(var(--radius-control)-2px)] shadow-card -z-10"
                aria-hidden="true"
              />
            )}
            {Icon && (
              <Icon
                size={size === 'sm' ? 12 : 14}
                aria-hidden={true}
                className={cn('shrink-0', isSelected ? 'text-accent' : 'text-hint')}
              />
            )}
            <span>{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
