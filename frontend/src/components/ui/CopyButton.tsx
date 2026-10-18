import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { IconSwap } from './IconSwap'

export interface CopyButtonProps {
  /** The text to copy to the clipboard */
  text: string
  /** Optional visible label when variant is 'button' */
  label?: string
  /** Label to display while in copied state */
  copiedLabel?: string
  /** 'icon' for compact circular trigger, 'button' for pill with label */
  variant?: 'icon' | 'button'
  size?: 'sm' | 'md'
  className?: string
  onCopied?: () => void
}

/**
 * Copy to clipboard button with IconSwap transition (Copy → Check) and 1.5s auto-reset.
 */
export function CopyButton({
  text,
  label,
  copiedLabel = 'Copied',
  variant = 'icon',
  size = 'sm',
  className,
  onCopied,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      onCopied?.()
    } catch {
      // Fallback for environments where clipboard permissions are denied
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      onCopied?.()
    }
  }

  const iconSize = size === 'sm' ? 13 : 15

  if (variant === 'button') {
    return (
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? copiedLabel : label ?? 'Copy to clipboard'}
        className={cn(
          'pressable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-control text-xs font-medium bg-surface-muted hover:bg-surface-muted/80 text-fg select-none outline-none',
          className
        )}
      >
        <IconSwap iconKey={copied ? 'copied' : 'copy'}>
          {copied ? (
            <Check size={iconSize} className="text-success" aria-hidden="true" />
          ) : (
            <Copy size={iconSize} className="text-hint" aria-hidden="true" />
          )}
        </IconSwap>
        <span>{copied ? copiedLabel : label ?? 'Copy'}</span>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
      title={copied ? 'Copied' : 'Copy to clipboard'}
      className={cn(
        'pressable-icon pressable-flat inline-flex items-center justify-center rounded-full p-1.5 text-hint hover:text-fg select-none outline-none shrink-0',
        size === 'sm' ? 'size-7' : 'size-8',
        className
      )}
    >
      <IconSwap iconKey={copied ? 'copied' : 'copy'}>
        {copied ? (
          <Check size={iconSize} className="text-success" aria-hidden="true" />
        ) : (
          <Copy size={iconSize} aria-hidden="true" />
        )}
      </IconSwap>
    </button>
  )
}
