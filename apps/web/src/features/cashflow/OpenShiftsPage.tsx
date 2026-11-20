import { useCallback, useEffect, useState } from 'react'
import { Layout } from '@/components/Layout'
import { desktopBridge } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'

type OpenShift = { id: string; cashier_id: string; cashier_name: string | null; opened_at: string; expected_cash?: number }
const kyivDate = (value: string) => new Date(value).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

/**
 * Фінанси → Зміни (рішення власника 20.11.2026): хто зараз на зміні, з якого часу і скільки готівки
 * має бути. Зміни касирів від 15.11 ніхто не міг закрити — касир закриває лише свою зміну в касі,
 * а забуту зміну тут закриває власник або адміністратор, вказавши фактичну готівку і причину.
 */
export default function OpenShiftsPage() {
  const [shifts, setShifts] = useState<OpenShift[] | null>(null)
  const role = useAuthStore((s) => (s.session?.user?.app_metadata?.role as string) ?? 'cashier')
  const canClose = role === 'owner' || role === 'admin'
  const load = useCallback(() => {
    const pos = desktopBridge()?.pos
    if (!pos?.listOpenShifts) { setShifts([]); return }
    void pos.listOpenShifts().then(rows => setShifts(rows)).catch(() => setShifts([]))
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <Layout title="Зміни">
      <div className="max-w-3xl">
        <p className="mb-4 text-sm text-gray-600">Відкриті зміни каси. Касир закриває свою зміну в касі кнопкою «Закрити зміну». Якщо касир забув — закрийте його зміну тут.</p>
        {shifts === null && <p className="text-sm text-gray-500">Завантаження…</p>}
        {shifts?.length === 0 && <p className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-600">Відкритих змін немає.</p>}
        <ul className="space-y-3">
          {shifts?.map(shift => <ShiftRow key={shift.id} shift={shift} canClose={canClose} onClosed={load} />)}
        </ul>
      </div>
    </Layout>
  )
}

function ShiftRow({ shift, canClose, onClosed }: { shift: OpenShift; canClose: boolean; onClosed: () => void }) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState(((shift.expected_cash ?? 0) / 100).toFixed(2))
  const [comment, setComment] = useState('Касир не закрив зміну; закрито власником')
  const [busy, setBusy] = useState(false)
  const name = shift.cashier_name ?? 'касир'
  const close = async () => {
    const kopecks = Math.round(Number(amount.replace(',', '.')) * 100)
    if (!amount.trim() || !Number.isSafeInteger(kopecks) || kopecks < 0) { toast.error('Вкажіть суму готівки'); return }
    if (!comment.trim()) { toast.error('Вкажіть причину'); return }
    const pos = desktopBridge()?.pos
    if (!pos) return
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
    <li className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-semibold text-gray-900">{name}</p>
          <p className="text-sm text-gray-600">Відкрито {kyivDate(shift.opened_at)} · готівки має бути {formatMoney(shift.expected_cash ?? 0)}</p>
        </div>
        {canClose && !open && (
          <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50">Закрити зміну</button>
        )}
      </div>
      {open && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-gray-100 pt-3">
          <label className="text-xs text-gray-600">Готівка фактично, грн
            <input value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" className="mt-1 block w-32 rounded border border-gray-300 px-2 py-1 text-sm" />
          </label>
          <label className="min-w-0 flex-1 text-xs text-gray-600">Причина
            <input value={comment} onChange={event => setComment(event.target.value)} className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 text-sm" />
          </label>
          <button type="button" disabled={busy} onClick={() => void close()} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">{busy ? 'Закриваю…' : 'Закрити'}</button>
          <button type="button" disabled={busy} onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100">Скасувати</button>
        </div>
      )}
    </li>
  )
}
