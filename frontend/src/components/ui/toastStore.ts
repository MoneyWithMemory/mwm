import { createContext, useContext } from 'react'

export type ToastType = 'info' | 'success' | 'danger' | 'warning'

export interface ToastItem {
  id: string
  title: string
  description?: string
  type?: ToastType
  duration?: number
}

export interface ToastContextValue {
  showToast: (toast: Omit<ToastItem, 'id'>) => string
  dismissToast: (id: string) => void
}

export const ToastContext = createContext<ToastContextValue | null>(null)

// Standalone toast listener system so `toast(...)` can be called from anywhere without hooks
type ToastListener = (toast: ToastItem) => void
export const toastListeners = new Set<ToastListener>()

export function toast(
  title: string,
  options?: { description?: string; type?: ToastType; duration?: number }
): string {
  const id = Math.random().toString(36).substring(2, 9)
  const item: ToastItem = {
    id,
    title,
    description: options?.description,
    type: options?.type ?? 'info',
    duration: options?.duration ?? 3500,
  }
  toastListeners.forEach((listener) => listener(item))
  return id
}

toast.info = (title: string, description?: string) => toast(title, { description, type: 'info' })
toast.success = (title: string, description?: string) => toast(title, { description, type: 'success' })
toast.error = (title: string, description?: string) => toast(title, { description, type: 'danger' })
toast.warning = (title: string, description?: string) => toast(title, { description, type: 'warning' })

export function useToast() {
  const ctx = useContext(ToastContext)
  return {
    toast,
    showToast: ctx?.showToast ?? ((t) => toast(t.title, t)),
    dismissToast: ctx?.dismissToast ?? (() => {}),
  }
}
