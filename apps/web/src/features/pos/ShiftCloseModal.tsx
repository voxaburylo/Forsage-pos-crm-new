import { useState, useEffect } from 'react'
import { shiftApi } from './shiftApi'
import type { ShiftReport } from '@/types/shift'
import type { ExpectedCash } from './shiftApi'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'
import { useAuthStore } from '@/stores/authStore'
import { desktopBridge } from '@/lib/desktopBridge'

interface Props {
  open: boolean
  shiftId: string
  offline?: boolean
  pendingOfflineSales?: number
  onClose: () => void
  onClosed: () => void
}

const VARIANCE_THRESHOLD = 1000  // 10 грн в копійках

export function ShiftCloseModal({
  open, shiftId, offline = false, pendingOfflineSales = 0, onClose, onClosed,
}: Props) {
  const session = useAuthStore((s) => s.session)
  const role = (session?.user?.app_metadata?.role as string) ?? 'cashier'
  const isOwnerOrAdmin = role === 'owner' || role === 'admin'
  const cashierId = session?.user?.id ?? ''
  const desktop = desktopBridge()
  const isDesktop = Boolean(desktop)

  const [report, setReport]             = useState<ShiftReport | null>(null)
  const [cashBreakdown, setCashBreakdown] = useState<ExpectedCash | null>(null)
  const [cashInput, setCashInput]       = useState('')
  const [comment, setComment]           = useState('')
  const [loading, setLoading]           = useState(false)
  const [closing, setClosing]           = useState(false)

  useEffect(() => {
    if (!open) return
    const desktopRuntime = desktopBridge()
    if (desktopRuntime && cashierId) {
      setLoading(true)
      Promise.all([
        desktopRuntime.pos.shiftReport(cashierId),
        desktopRuntime.pos.expectedCash(cashierId),
      ])
        .then(([localReport, localCash]) => {
          setReport(localReport)
          setCashBreakdown(localCash)
        })
        .catch(() => toast.error('Помилка завантаження локальних даних зміни'))
        .finally(() => setLoading(false))
      return
    }
    if (offline) {
      setLoading(false)
      return
    }
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
  }, [open, shiftId, offline, cashierId])

  if (!open) return null

  const cashReceived = Math.round(parseFloat(cashInput || '0') * 100)
  const expectedCash = cashBreakdown?.expected_amount ?? 0
  const variance     = cashInput ? cashReceived - expectedCash : null
  const needsComment = isOwnerOrAdmin && variance !== null && Math.abs(variance) > VARIANCE_THRESHOLD

  async function handleClose() {
    if (offline && !isDesktop) {
      toast.error('Закриття зміни потребує інтернету')
      return
    }
    if (pendingOfflineSales > 0) {
      toast.error(`Спочатку синхронізуйте офлайн-чеки: ${pendingOfflineSales}`)
      return
    }
    if (needsComment && !comment.trim()) {
      toast.error('Розбіжність > 10 грн — поясніть у коментарі')
      return
    }
    setClosing(true)
    try {
      if (desktop && cashierId) {
        await desktop.pos.closeShift(cashierId, cashReceived, comment.trim() || null)
        window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
      } else {
        try {
          await shiftApi.close(shiftId, cashReceived, comment || undefined)
        } catch (err) {
          // Бек вимагає запис звірки каси перед закриттям. Фактичну суму касир
          // щойно ввів у цій модалці — створюємо звірку з неї і повторюємо закриття.
          if (err instanceof Error && /звірку каси/i.test(err.message)) {
            const { api } = await import('@/lib/api')
            await api.post('/api/v1/shifts/current/reconcile', {
              actual_amount: cashReceived,
              comment: comment.trim() || null,
            })
            await shiftApi.close(shiftId, cashReceived, comment || undefined)
          } else {
            throw err
          }
        }
      }
      // Залишок на кінець зміни = початок наступної (та сама каса) → підставимо при відкритті
      try { localStorage.setItem('forsage_last_shift_close_cash', (cashReceived / 100).toFixed(2)) } catch { /* ignore */ }
      toast.success('Зміну закрито')

      // Desktop + увімкнений ПРРО Кашалот: закриваємо фіскальну зміну (Z-звіт).
      if (desktop?.fiscal) {
        try {
          const fiscalConfig = await desktop.fiscal.getConfig()
          if (fiscalConfig.enabled) {
            await desktop.fiscal.closeShift()
            toast.success('Z-звіт ПРРО зареєстровано')
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // Якщо фіскальна зміна й не відкривалась (не було фіскальних чеків) — це не помилка.
          if (!/не відкрит|not open/i.test(message)) {
            toast.warning('Зміну закрито, але Z-звіт ПРРО не пройшов: ' + message + '. Закрийте зміну в Кашалоті вручну.')
          }
        }
      }
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
        {((offline && !isDesktop) || pendingOfflineSales > 0) && (
          <div className="rounded-xl border border-red-500/50 bg-red-900/25 px-4 py-3 text-sm text-red-300">
            {offline && !isDesktop
              ? 'Зміну не можна закрити без інтернету.'
              : `Не синхронізовано офлайн-чеків: ${pendingOfflineSales}. Спочатку передайте їх на сервер.`}
          </div>
        )}
        {offline && isDesktop && (
          <div className="rounded-xl border border-blue-500/40 bg-blue-900/20 px-4 py-3 text-sm text-blue-300">
            Зміну буде закрито локально. Дані передадуться на сервер після відновлення інтернету.
          </div>
        )}

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
            {isOwnerOrAdmin && (
              <div className="bg-[#2C2C2C] rounded-xl p-4 space-y-2 text-sm">
                <div className="flex justify-between text-gray-400">
                  <span>Початкова готівка:</span>
                  <span>{formatMoney(cashBreakdown?.opening_cash ?? 0)}</span>
                </div>
                <div className="flex justify-between text-gray-400">
                  <span>Продажі готівкою:</span>
                  <span className="text-green-400">+{formatMoney(cashBreakdown?.cash_sales ?? 0)}</span>
                </div>
                <div className="flex justify-between text-gray-400">
                  <span>Оплати через термінал:</span>
                  <span className="text-blue-400">{formatMoney(report.by_method.card ?? 0)}</span>
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
                <p className="border-t border-gray-700 pt-2 text-[11px] leading-4 text-gray-500">
                  У Z-звіті Кашалота це один звіт із окремими підсумками: готівка та безготівкова оплата.
                </p>
              </div>
            )}

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
            {isOwnerOrAdmin && variance !== null && (
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

            {/* Коментар */}
            <div>
              <label className={`text-xs mb-1 block ${needsComment ? 'text-red-400' : 'text-gray-400'}`}>
                {needsComment ? '⚠️ Коментар обов' + "'" + 'язковий (розбіжність > 10 грн)' : 'Коментар (необов' + "'" + 'язково)'}
              </label>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={2}
                placeholder="Поясніть причину розбіжності..."
                className={`w-full bg-[#2C2C2C] text-white text-sm rounded-xl px-4 py-2 border ${needsComment ? 'border-red-500/50 focus:border-red-400' : 'border-gray-700 focus:border-[#FFD000]'} resize-none focus:outline-none`}
              />
            </div>
          </>
        )}

        <div className="flex gap-3">
          <button onClick={onClose}
            className="flex-1 py-3 rounded-xl bg-[#2C2C2C] text-gray-300 font-semibold hover:bg-gray-700 transition-colors">
            Скасувати
          </button>
          <button onClick={handleClose} disabled={(offline && !isDesktop) || pendingOfflineSales > 0 || closing || loading || (cashInput === '' && !loading)}
            style={{ minHeight: 56 }}
            className="flex-1 py-3 rounded-xl bg-[#FFD000] text-black font-bold hover:bg-yellow-300 disabled:opacity-40 transition-colors">
            {closing ? 'Закриваємо...' : 'Закрити зміну'}
          </button>
        </div>
      </div>
    </div>
  )
}
