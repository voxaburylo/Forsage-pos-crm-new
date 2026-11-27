import { useEffect, useState } from 'react'
import { CheckCircle, XCircle, AlertTriangle, X } from 'lucide-react'

type ToastType = 'success' | 'error' | 'warning'

/** 27.11.2026: кнопка в повідомленні (наприклад, «Відкрити замовлення» на касі). Таке повідомлення висить довше. */
export interface ToastAction { label: string; onClick: () => void }

interface ToastData {
  id: number
  type: ToastType
  message: string
  action?: ToastAction
}

let toastCounter = 0
const listeners: Array<(toast: ToastData) => void> = []
const recentlyShown = new Map<string, number>()
const TOAST_DEDUPE_MS = 1_500

export function toast(message: string, type: ToastType = 'success', action?: ToastAction) {
  const key = `${type}:${message}`
  const now = Date.now()
  if (now - (recentlyShown.get(key) ?? 0) < TOAST_DEDUPE_MS) return
  recentlyShown.set(key, now)
  const data: ToastData = { id: ++toastCounter, type, message, ...(action ? { action } : {}) }
  listeners.forEach((l) => l(data))
}
toast.success = (m: string) => toast(m, 'success')
toast.error   = (m: string, action?: ToastAction) => toast(m, 'error', action)
toast.warning = (m: string, action?: ToastAction) => toast(m, 'warning', action)

const ICONS = {
  success: <CheckCircle size={18} className="text-green-500" />,
  error:   <XCircle size={18} className="text-red-500" />,
  warning: <AlertTriangle size={18} className="text-orange-500" />,
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastData[]>([])

  useEffect(() => {
    const handler = (t: ToastData) => {
      setToasts((prev) => [...prev, t].slice(-4))
      setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), t.action ? 12_000 : 4000)
    }
    listeners.push(handler)
    return () => { const i = listeners.indexOf(handler); if (i >= 0) listeners.splice(i, 1) }
  }, [])

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className="flex items-center gap-3 bg-white border border-gray-200 shadow-lg rounded-xl px-4 py-3 min-w-[280px] max-w-md">
          {ICONS[t.type]}
          <span className="text-sm text-gray-800 flex-1">{t.message}</span>
          {t.action && (
            <button type="button" data-toast-action className="shrink-0 rounded-lg bg-gray-900 px-2.5 py-1 text-xs font-semibold text-white"
              onClick={() => { t.action!.onClick(); setToasts((prev) => prev.filter((x) => x.id !== t.id)) }}>
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            aria-label="Закрити повідомлення"
            title="Закрити повідомлення"
          >
            <X size={14} className="text-gray-400 hover:text-gray-600" />
          </button>
        </div>
      ))}
    </div>
  )
}
