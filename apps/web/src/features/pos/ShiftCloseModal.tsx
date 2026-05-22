import { useState, useEffect } from 'react'
import { shiftApi } from './shiftApi'
import type { ShiftReport } from '@/types/shift'
import type { ExpectedCash } from './shiftApi'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'

interface Props {
  open: boolean
  shiftId: string
  onClose: () => void
  onClosed: () => void
}

const VARIANCE_THRESHOLD = 1000  // 10 грн в копійках

export function ShiftCloseModal({ open, shiftId, onClose, onClosed }: Props) {
  const [report, setReport]             = useState<ShiftReport | null>(null)
  const [cashBreakdown, setCashBreakdown] = useState<ExpectedCash | null>(null)
  const [cashInput, setCashInput]       = useState('')
  const [comment, setComment]           = useState('')
  const [loading, setLoading]           = useState(false)
  const [closing, setClosing]           = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    Promise.all([
      shiftApi.report(shiftId),
      shiftApi.expectedCash(),
    ])
      .then(([reportRes, cashRes]) => {
        setReport(reportRes.data)
        setCashBreakdown(cashRes.data)
      })
      .catch(() => toast.error('Помилка завантаження даних зміни'))
      .finally(() => setLoading(false))
  }, [open, shiftId])

  if (!open) return null

  const cashReceived = Math.round(parseFloat(cashInput || '0') * 100)
  const expectedCash = cashBreakdown?.expected_amount ?? 0
  const variance     = cashInput ? cashReceived - expectedCash : null
  const needsComment = variance !== null && Math.abs(variance) > VARIANCE_THRESHOLD

  async function handleClose() {
    if (needsComment && !comment.trim()) {
      toast.error('Розбіжність > 10 грн — поясніть у коментарі')
      return
    }
    setClosing(true)
    try {
      await shiftApi.close(shiftId, cashReceived, comment || undefined)
      toast.success('Зміну закрито')
      onClosed()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка закриття зміни')
    } finally {
      setClosing(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-[#1A1A1A] rounded-2xl border border-gray-700 w-full max-w-sm mx-4 p-6 space-y-5">
        <h2 className="text-white text-lg font-bold">Закрити зміну</h2>

        {/* Нагадування звірки */}
        {!loading && cashInput === '' && (
          <div className="bg-yellow-900/30 border border-yellow-500/40 rounded-xl px-4 py-3 text-yellow-300 text-sm">
            Перед закриттям перерахуйте готівку в касі і введіть фактичну суму нижче.
          </div>
        )}

        {loading ? (
          <p className="text-gray-400 text-sm text-center">Завантаження...</p>
        ) : report && (
          <>
            {/* Розбивка готівки */}
            <div className="bg-[#2C2C2C] rounded-xl p-4 space-y-2 text-sm">
              <div className="flex justify-between text-gray-400">
                <span>Початкова готівка:</span>
                <span>{formatMoney(cashBreakdown?.opening_cash ?? 0)}</span>
              </div>
              <div className="flex justify-between text-gray-400">
                <span>Продажі готівкою:</span>
                <span className="text-green-400">+{formatMoney(cashBreakdown?.cash_sales ?? 0)}</span>
              </div>
              {(cashBreakdown?.cash_in ?? 0) > 0 && (
                <div className="flex justify-between text-gray-400">
                  <span>Внесення в касу:</span>
                  <span className="text-green-400">+{formatMoney(cashBreakdown?.cash_in ?? 0)}</span>
                </div>
              )}
              {(cashBreakdown?.cash_returns ?? 0) > 0 && (
                <div className="flex justify-between text-gray-400">
                  <span>Повернення готівкою:</span>
                  <span className="text-red-400">−{formatMoney(cashBreakdown?.cash_returns ?? 0)}</span>
                </div>
              )}
              {(cashBreakdown?.cash_out ?? 0) > 0 && (
                <div className="flex justify-between text-gray-400">
                  <span>Витрати з каси:</span>
                  <span className="text-red-400">−{formatMoney(cashBreakdown?.cash_out ?? 0)}</span>
                </div>
              )}
              <div className="flex justify-between text-white font-semibold border-t border-gray-700 pt-2">
                <span>Очікується в касі:</span>
                <span>{formatMoney(expectedCash)}</span>
              </div>
              <div className="flex justify-between text-gray-300 text-xs">
                <span>Всього продажів: {report.total_sales} чек(ів)</span>
                <span>Виручка: {formatMoney(report.total_revenue)}</span>
              </div>
            </div>

            {/* Ввід фактичної суми */}
            <div>
              <label className="text-gray-400 text-xs mb-1 block">Фактична сума в касі (₴)</label>
              <input
                type="number" min="0" step="0.01" autoFocus
                value={cashInput}
                onChange={(e) => setCashInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleClose() }}
                placeholder="0.00"
                className="w-full bg-[#2C2C2C] text-white text-2xl font-bold text-center rounded-xl px-4 py-3 border border-gray-700 focus:outline-none focus:border-[#FFD000]"
              />
            </div>

            {/* Варіанс */}
            {variance !== null && (
              <div className={`rounded-xl px-4 py-3 text-sm font-medium text-center ${
                Math.abs(variance) <= VARIANCE_THRESHOLD
                  ? 'bg-green-900/30 border border-green-500/50 text-green-400'
                  : variance > 0
                    ? 'bg-blue-900/30 border border-blue-500/50 text-blue-400'
                    : 'bg-red-900/30 border border-red-500/50 text-red-400'
              }`}>
                {Math.abs(variance) <= VARIANCE_THRESHOLD && `✓ Розбіжність: ${formatMoney(Math.abs(variance))} (норма)`}
                {variance > VARIANCE_THRESHOLD && `↑ Надлишок: ${formatMoney(variance)}`}
                {variance < -VARIANCE_THRESHOLD && `↓ Нестача: ${formatMoney(Math.abs(variance))}`}
              </div>
            )}

            {/* Коментар (обов'язковий при великому варіансі) */}
            {needsComment && (
              <div>
                <label className="text-red-400 text-xs mb-1 block">
                  ⚠️ Коментар обов'язковий (розбіжність &gt; 10 грн)
                </label>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={2}
                  placeholder="Поясніть причину розбіжності..."
                  className="w-full bg-[#2C2C2C] text-white text-sm rounded-xl px-4 py-2 border border-red-500/50 focus:outline-none focus:border-red-400 resize-none"
                />
              </div>
            )}

            {!needsComment && (
              <div>
                <label className="text-gray-400 text-xs mb-1 block">Коментар (необов'язково)</label>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={2}
                  placeholder="Примітки до зміни..."
                  className="w-full bg-[#2C2C2C] text-white text-sm rounded-xl px-4 py-2 border border-gray-700 focus:outline-none focus:border-[#FFD000] resize-none"
                />
              </div>
            )}
          </>
        )}

        <div className="flex gap-3">
          <button onClick={onClose}
            className="flex-1 py-3 rounded-xl bg-[#2C2C2C] text-gray-300 font-semibold hover:bg-gray-700 transition-colors">
            Скасувати
          </button>
          <button onClick={handleClose} disabled={closing || loading || cashInput === ''}
            style={{ minHeight: 56 }}
            className="flex-1 py-3 rounded-xl bg-[#FFD000] text-black font-bold hover:bg-yellow-300 disabled:opacity-40 transition-colors">
            {closing ? 'Закриваємо...' : 'Закрити зміну'}
          </button>
        </div>
      </div>
    </div>
  )
}
