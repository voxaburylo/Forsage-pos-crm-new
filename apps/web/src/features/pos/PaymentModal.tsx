import { useState } from 'react'
import { Banknote, CreditCard, BookOpen } from 'lucide-react'
import { usePOSStore } from '@/stores/posStore'
import { formatMoney } from '@/lib/utils'

interface Props {
  open: boolean
  onClose: () => void
  onConfirm: (method: 'cash' | 'card' | 'debt', cashReceived?: number) => Promise<void>
}

type Method = 'cash' | 'card' | 'debt'

const METHODS: { id: Method; label: string; icon: React.ReactNode; color: string }[] = [
  { id: 'cash', label: 'Готівка',  icon: <Banknote size={20} />,    color: 'bg-green-500 hover:bg-green-400' },
  { id: 'card', label: 'Картка',   icon: <CreditCard size={20} />,  color: 'bg-blue-500 hover:bg-blue-400' },
  { id: 'debt', label: 'Борг',     icon: <BookOpen size={20} />,    color: 'bg-red-500 hover:bg-red-400' },
]

export function PaymentModal({ open, onClose, onConfirm }: Props) {
  const store           = usePOSStore()
  const [method, setMethod]   = useState<Method>('cash')
  const [cashInput, setCash]  = useState('')
  const [loading, setLoading] = useState(false)

  if (!open) return null

  const cashReceived  = parseFloat(cashInput || '0') * 100  // в копійки
  const change        = Math.max(0, cashReceived - store.total)
  const cashValid     = method !== 'cash' || cashReceived >= store.total
  const debtOk        = method !== 'debt' || !!store.customer

  async function handleConfirm() {
    if (!cashValid) return
    if (!debtOk) return
    setLoading(true)
    await onConfirm(method, method === 'cash' ? cashReceived : undefined)
    setLoading(false)
    setCash('')
    setMethod('cash')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-[#1A1A1A] rounded-2xl border border-gray-700 w-full max-w-sm mx-4 overflow-hidden">

        {/* Заголовок */}
        <div className="px-6 py-4 border-b border-gray-800">
          <p className="text-gray-400 text-sm">До оплати</p>
          <p className="text-white text-4xl font-bold">{formatMoney(store.total)}</p>
          {store.customer && (
            <p className="text-yellow-400 text-sm mt-1">
              Клієнт: {store.customer.name ?? store.customer.phone}
            </p>
          )}
        </div>

        <div className="p-6 space-y-5">
          {/* Вибір методу */}
          <div className="grid grid-cols-3 gap-2">
            {METHODS.map((m) => (
              <button
                key={m.id}
                onClick={() => setMethod(m.id)}
                style={{ minHeight: 64 }}
                className={`flex flex-col items-center justify-center gap-1.5 rounded-xl text-white text-xs font-semibold transition-all ${
                  method === m.id ? m.color + ' ring-2 ring-white/30' : 'bg-[#2C2C2C] hover:bg-gray-700'
                }`}
              >
                {m.icon}
                {m.label}
              </button>
            ))}
          </div>

          {/* Готівка: поле введення */}
          {method === 'cash' && (
            <div>
              <label className="text-gray-400 text-xs mb-1 block">Отримано готівки (₴)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                autoFocus
                value={cashInput}
                onChange={(e) => setCash(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm() }}
                placeholder="0.00"
                className="w-full bg-[#2C2C2C] text-white text-2xl font-bold text-center rounded-xl px-4 py-3 border border-gray-700 focus:outline-none focus:border-yellow-400"
              />
              {cashReceived >= store.total && cashReceived > 0 && (
                <p className="text-green-400 text-center text-sm mt-2 font-medium">
                  Решта: {formatMoney(change)}
                </p>
              )}
              {cashInput && cashReceived < store.total && (
                <p className="text-red-400 text-center text-sm mt-2">
                  Не вистачає: {formatMoney(store.total - cashReceived)}
                </p>
              )}
            </div>
          )}

          {/* Борг — попередження якщо нема клієнта */}
          {method === 'debt' && !store.customer && (
            <div className="bg-red-900/30 border border-red-500/50 rounded-xl px-4 py-3">
              <p className="text-red-400 text-sm text-center">
                Вкажіть клієнта в чеку для продажу в борг
              </p>
            </div>
          )}

          {/* Кнопки */}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-4 rounded-xl bg-[#2C2C2C] text-gray-300 font-semibold hover:bg-gray-700 transition-colors"
            >
              Скасувати
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading || !cashValid || !debtOk}
              style={{ minHeight: 56 }}
              className="flex-1 py-4 rounded-xl bg-yellow-400 text-black font-bold hover:bg-yellow-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Обробка...' : 'ПІДТВЕРДИТИ'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
