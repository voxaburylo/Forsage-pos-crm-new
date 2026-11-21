import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { desktopBridge } from '@/lib/desktopBridge'

type OpenShift = { id: string; cashier_name: string | null; opened_at: string }
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
  const navigate = useNavigate()
  const [stale, setStale] = useState<Array<OpenShift & { days: number }>>([])
  const [lastBackup, setLastBackup] = useState<string | null>(null)
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
        <p className="mt-1">Поки зміну не закрито, не створюється резервна копія «при закритті зміни» і не йде копія в хмару. Касир закриває свою зміну в касі; забуту зміну власник закриває в <button type="button" onClick={() => navigate('/shifts')} className="font-semibold underline">Фінанси → Зміни</button>.
          {lastBackup ? ` Остання копія зміни: ${new Date(lastBackup).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}.` : ' Копій змін ще немає.'}</p>
      </div>
    </div>
  )
}
