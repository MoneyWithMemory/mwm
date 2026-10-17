type ClassValue = string | false | null | undefined

/** Joins class names, skipping falsy values: cn('pressable', active && 'bg-accent'). */
export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(' ')
}
