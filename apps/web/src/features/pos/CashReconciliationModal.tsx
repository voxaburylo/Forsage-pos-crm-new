import { useState, useEffect } from 'react'
import { X, DollarSign } from 'lucide-react'
import { api } from '@/lib/api'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'
import { useAuthStore } from '@/stores/authStore'

interface Props {
  open: boolean
  onClose: () => void
}

export function CashReconciliationModal({ open, onClose }: Props) {
  const session = useAuthStore((s) => s.session)
  const role = (session?.user?.user_metadata?.role as string) ?? 'cashier'
  const isOwnerOrAdmin = role === 'owner' || role === 'admin'

  const [expected, setExpected] = useState(0)
  const [breakdown, setBreakdown] = useState<Record<string, number>>({})
  const [actual, setActual] = useState('')
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    api.get<{ data: Record<string, number> }>('/api/v1/shifts/current/expected-cash')
      .then((res) => {
        setExpected(res.data.expected_amount ?? 0)
        setBreakdown(res.data)
      })
      .catch(() => toast.error('Помилка завантаження даних'))
      .finally(() => setLoading(false))
  }, [open])

  if (!open) return null

  const actualKopecks = Math.round(parseFloat(actual || '0') * 100)
  const difference = actualKopecks - expected
  const hasDiff = difference !== 0
  const needsComment = isOwnerOrAdmin && hasDiff && !comment.trim()

  async function handleSave() {
    if (needsComment) { toast.error('При розбіжності вкажіть коментар'); return }
    if (actualKopecks < 0) { toast.error('Сума не може бути від\'ємною'); return }

    setSaving(true)
    try {
      await api.post('/api/v1/shifts/current/reconcile', {
        actual_amount: actualKopecks,
        comment: comment.trim() || null,
      })
      toast.success(`Звірку каси збережено. Різниця: ${formatMoney(Math.abs(difference))}${difference > 0 ? ' надлишок' : difference < 0 ? ' нестача' : ''}`)
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-[#1A1A1A] rounded-2xl border border-gray-700 w-full max-w-md mx-4 p-6 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <DollarSign size={20} className="text-yellow-400" />
            <h2 className="text-white text-lg font-bold">Звірка каси</h2>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={20} /></button>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm text-center py-8">Завантаження...</p>
        ) : (
          <div className="space-y-5">
            {/* Expected */}
            {isOwnerOrAdmin && (
              <div className="bg-[#2C2C2C] rounded-xl p-4 text-center">
                <p className="text-gray-400 text-xs mb-1">Очікувана сума в касі</p>
                <p className="text-white text-4xl font-bold">{formatMoney(expected)}</p>
              </div>
            )}

            {/* Breakdown */}
            {isOwnerOrAdmin && (
              <div className="bg-[#242424] rounded-xl p-3 space-y-1 text-xs">
                <div className="flex justify-between text-gray-400"><span>Початковий залишок</span><span>{formatMoney(breakdown.opening_cash ?? 0)}</span></div>
                <div className="flex justify-between text-green-400"><span>+ Продажі готівкою</span><span>+{formatMoney(breakdown.cash_sales ?? 0)}</span></div>
                <div className="flex justify-between text-red-400"><span>− Повернення</span><span>-{formatMoney(breakdown.cash_returns ?? 0)}</span></div>
                <div className="flex justify-between text-blue-400"><span>+ Внесення</span><span>+{formatMoney(breakdown.cash_in ?? 0)}</span></div>
                <div className="flex justify-between text-orange-400"><span>− Вилучення</span><span>-{formatMoney(breakdown.cash_out ?? 0)}</span></div>
                <div className="border-t border-gray-700 pt-1 flex justify-between text-white font-semibold">
                  <span>= Очікується</span><span>{formatMoney(expected)}</span>
                </div>
              </div>
            )}

            {/* Actual input */}
            <div>
              <label className="text-gray-400 text-xs mb-1 block">Фактична сума в касі (₴)</label>
              <input type="number" min="0" step="0.01" autoFocus value={actual}
                onChange={(e) => setActual(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
                placeholder="0.00"
                className="w-full bg-[#2C2C2C] text-white text-3xl font-bold text-center rounded-xl px-4 py-4 border border-gray-700 focus:outline-none focus:border-yellow-400" />
            </div>

            {/* Difference */}
            {isOwnerOrAdmin && actual && (
              <div className={`rounded-xl px-4 py-3 text-center font-bold text-lg ${
                difference === 0 ? 'bg-gray-800 text-gray-400' :
                difference > 0 ? 'bg-green-900/40 text-green-400 border border-green-500/40' :
                'bg-red-900/40 text-red-400 border border-red-500/40'
              }`}>
                {difference === 0 ? '✅ Сума сходиться' :
                 difference > 0 ? `↑ Надлишок: ${formatMoney(difference)}` :
                 `↓ Нестача: ${formatMoney(Math.abs(difference))}`}
              </div>
            )}

            {/* Comment */}
            {isOwnerOrAdmin && hasDiff ? (
              <div>
                <label className="text-red-400 text-xs mb-1 block">
                  ⚠️ Коментар обов'язковий (розбіжність)
                </label>
                <textarea value={comment} onChange={(e) => setComment(e.target.value)}
                  rows={2} placeholder="Поясніть причину розбіжності..."
                  className="w-full bg-[#2C2C2C] text-white text-sm rounded-xl px-4 py-2 border border-red-500/50 focus:outline-none focus:border-red-400 resize-none" />
              </div>
            ) : (
              <div>
                <label className="text-gray-400 text-xs mb-1 block">Коментар (необов'язково)</label>
                <textarea value={comment} onChange={(e) => setComment(e.target.value)}
                  rows={2} placeholder="Примітки..."
                  className="w-full bg-[#2C2C2C] text-white text-sm rounded-xl px-4 py-2 border border-gray-700 focus:outline-none focus:border-yellow-400 resize-none" />
              </div>
            )}

            {/* Buttons */}
            <div className="flex gap-3">
              <button onClick={onClose}
                className="flex-1 py-3 rounded-xl bg-[#2C2C2C] text-gray-300 font-semibold hover:bg-gray-700 transition-colors">Скасувати</button>
              <button onClick={handleSave} disabled={saving || !actual}
                className="flex-1 py-3 rounded-xl bg-yellow-400 text-black font-bold hover:bg-yellow-300 disabled:opacity-40 transition-colors">
                {saving ? 'Збереження...' : 'Зберегти звірку'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
