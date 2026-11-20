import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { desktopBridge } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'

type OpenShift = { id: string; cashier_id?: string; cashier_name: string | null; opened_at: string; expected_cash?: number }
const kyivDay = (value: string | Date) => new Date(value).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' })

/** Відкриті зміни, начаті не сьогодні (за київським календарем), з кількістю днів. */
export function staleShifts(shifts: readonly OpenShift[], now = new Date()): Array<OpenShift & { days: number }> {
  const today = kyivDay(now)
  return shifts.filter(shift => kyivDay(shift.opened_at) < today).map(shift => ({
    ...shift,
    days: Math.max(1, Math.round((Date.parse(today) - Date.parse(kyivDay(shift.opened_at))) / 86_400_000)),
  }))
}

/**
 * 19.11.2026: зміни не закривались з 14.11 — без закриття не робиться резервна копія «при закритті
 * зміни» і не йде копія в хмару. Нагадування на головній, поки є відкрита зміна з минулих днів.
 */
export function ShiftReminder() {
  const [stale, setStale] = useState<Array<OpenShift & { days: number }>>([])
  const [lastBackup, setLastBackup] = useState<string | null>(null)
  const role = useAuthStore((s) => (s.session?.user?.app_metadata?.role as string) ?? 'cashier')
  const canCloseForeign = role === 'owner' || role === 'admin'
  const reload = useCallback(() => {
    void desktopBridge()?.pos?.listOpenShifts?.().then(rows => setStale(staleShifts(rows))).catch(() => {})
  }, [])
  useEffect(() => {
    let alive = true
    const desktop = desktopBridge()
    void desktop?.pos?.listOpenShifts?.().then(rows => { if (alive) setStale(staleShifts(rows)) }).catch(() => {})
    void desktop?.shiftBackups?.status().then(rows => {
      const last = rows.map(row => row.captured_at).filter((value): value is string => Boolean(value)).sort().pop() ?? null
      if (alive) setLastBackup(last)
    }).catch(() => {})
    return () => { alive = false }
  }, [])
  if (!stale.length) return null
  return (
    <div role="alert" className="mb-4 flex gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <AlertTriangle size={18} className="mt-0.5 shrink-0" />
      <div>
        <p className="font-semibold">Зміну не закрито: {stale.map(shift => `${shift.cashier_name ?? 'касир'} — ${shift.days} дн. (з ${new Date(shift.opened_at).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' })})`).join('; ')}</p>
        <p className="mt-1">Поки зміну не закрито, не створюється резервна копія «при закритті зміни» і не йде копія в хмару. Закрийте зміну в касі (кнопка «Закрити зміну»).
          {lastBackup ? ` Остання копія зміни: ${new Date(lastBackup).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}.` : ' Копій змін ще немає.'}</p>
        {canCloseForeign && stale.map(shift => shift.cashier_id ? <StaleShiftClose key={shift.id} shift={shift} onClosed={reload} /> : null)}
      </div>
    </div>
  )
}

/**
 * 20.11.2026: зміни касирів від 15.11 ніхто не міг закрити — закрити можна було лише зі свого входу.
 * Власник/адміністратор закриває забуту зміну тут: вказує фактичну готівку і причину.
 */
function StaleShiftClose({ shift, onClosed }: { shift: OpenShift & { days: number }; onClosed: () => void }) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState(((shift.expected_cash ?? 0) / 100).toFixed(2))
  const [comment, setComment] = useState('Касир не закрив зміну; закрито власником')
  const [busy, setBusy] = useState(false)
  const name = shift.cashier_name ?? 'касир'
  if (!open) return (
    <button type="button" onClick={() => setOpen(true)} className="mt-2 mr-2 rounded-lg border border-amber-400 bg-white px-3 py-1.5 font-medium text-amber-900 hover:bg-amber-100">
      Закрити зміну: {name}
    </button>
  )
  const close = async () => {
    const kopecks = Math.round(Number(amount.replace(',', '.')) * 100)
    if (!amount.trim() || !Number.isSafeInteger(kopecks) || kopecks < 0) { toast.error('Вкажіть суму готівки'); return }
    if (!comment.trim()) { toast.error('Вкажіть причину'); return }
    const pos = desktopBridge()?.pos
    if (!pos || !shift.cashier_id) return
    setBusy(true)
    try {
      await pos.closeShift(shift.cashier_id, kopecks, comment.trim(), shift.id)
      window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
      toast.success(`Зміну «${name}» закрито`)
      onClosed()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося закрити зміну')
    } finally { setBusy(false) }
  }
  return (
    <div className="mt-3 rounded-lg border border-amber-300 bg-white p-3 text-slate-800">
      <p className="font-medium">Закрити зміну «{name}» від {new Date(shift.opened_at).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' })}</p>
      <p className="mt-1 text-xs text-slate-600">За даними програми в цій зміні має бути готівки {formatMoney(shift.expected_cash ?? 0)}. Якщо фактично інакше — вкажіть фактичну суму.</p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-xs">Готівка, грн
          <input value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" className="mt-1 block w-32 rounded border border-slate-300 px-2 py-1 text-sm" />
        </label>
        <label className="min-w-0 flex-1 text-xs">Причина
          <input value={comment} onChange={event => setComment(event.target.value)} className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm" />
        </label>
        <button type="button" disabled={busy} onClick={() => void close()} className="rounded-lg bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700 disabled:opacity-50">{busy ? 'Закриваю…' : 'Закрити зміну'}</button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100">Скасувати</button>
      </div>
    </div>
  )
}
