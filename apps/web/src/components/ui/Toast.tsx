import { useEffect, useState } from 'react'
import { CheckCircle, XCircle, AlertTriangle, X } from 'lucide-react'

type ToastType = 'success' | 'error' | 'warning'

interface ToastData {
  id: number
  type: ToastType
  message: string
}

let toastCounter = 0
const listeners: Array<(toast: ToastData) => void> = []

export function toast(message: string, type: ToastType = 'success') {
  const data: ToastData = { id: ++toastCounter, type, message }
  listeners.forEach((l) => l(data))
}
toast.success = (m: string) => toast(m, 'success')
toast.error   = (m: string) => toast(m, 'error')
toast.warning = (m: string) => toast(m, 'warning')

const ICONS = {
  success: <CheckCircle size={18} className="text-green-500" />,
  error:   <XCircle size={18} className="text-red-500" />,
  warning: <AlertTriangle size={18} className="text-orange-500" />,
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastData[]>([])

  useEffect(() => {
    const handler = (t: ToastData) => {
      setToasts((prev) => [...prev, t])
      setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), 4000)
    }
    listeners.push(handler)
    return () => { const i = listeners.indexOf(handler); if (i >= 0) listeners.splice(i, 1) }
  }, [])

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="flex items-center gap-3 bg-white border border-gray-200 shadow-lg rounded-xl px-4 py-3 min-w-[280px]">
          {ICONS[t.type]}
          <span className="text-sm text-gray-800 flex-1">{t.message}</span>
          <button onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}>
            <X size={14} className="text-gray-400 hover:text-gray-600" />
          </button>
        </div>
      ))}
    </div>
  )
}
