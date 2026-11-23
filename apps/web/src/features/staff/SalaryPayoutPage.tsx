import { useCallback, useEffect, useState } from 'react'
import { Wallet } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { businessDateKey } from '@/lib/businessDate'
import { formatMoney } from '@/lib/utils'
import { shiftApi } from '@/features/pos/shiftApi'
import { staffApi, type SalaryFundSource } from './staffApi'
import { type PayoutRow, payoutErrorText, payoutTotal } from './salaryPayoutModel'

/**
 * 23.11.2026 (власник): «Видати зарплату» — для касира наприкінці дня, перед закриттям зміни.
 * Лише видача заробленого за сьогодні з власної зміни; ставки, історія й правки — у власника («Зарплата»).
 * Гроші — тільки на касі: через веб виплата закрита (як і всі касові операції).
 */
export default function SalaryPayoutPage() {
  const [rows, setRows] = useState<PayoutRow[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const workDate = businessDateKey()

  const load = useCallback(async () => {
    setError('')
    try { setRows(await staffApi.payoutList(workDate)) } catch (reason) {
      setRows(null)
      setError(reason instanceof Error ? reason.message : 'Не вдалося завантажити список')
    }
  }, [workDate])
  useEffect(() => { if (isDesktopRuntime()) void load() }, [load])

  async function pay(row: PayoutRow, fundSource: SalaryFundSource) {
    if (busy) return
    const question = fundSource === 'owner_funds'
      ? `Власник доніс свої гроші? Видати ${row.employee_name} ${formatMoney(row.due)} коштами власника. Залишок каси не зміниться.`
      : `Видати ${row.employee_name} ${formatMoney(row.due)} з каси?`
    if (!window.confirm(question)) return
    setBusy(row.employee_id)
    try {
      const { data: shift } = await shiftApi.current({ silent: true })
      if (!shift?.id) { toast.error('Спочатку відкрийте касову зміну'); return }
      const result = await staffApi.dailyPayout({
        employee_id: row.employee_id, employee_name: row.employee_name, method: 'cash',
        fund_source: fundSource, shift_id: shift.id, work_date: workDate,
      })
      toast.success(`Видано ${row.employee_name}: ${formatMoney(result.data.amount)}`)
      await load()
    } catch (reason) {
      toast.error(payoutErrorText(reason instanceof Error ? reason.message : 'Не вдалося видати зарплату'))
    } finally { setBusy(null) }
  }

  if (!isDesktopRuntime()) {
    return <div className="p-4"><Card className="p-4 text-sm text-gray-700">Зарплату видають лише на касі: гроші через веб закрито.</Card></div>
  }
  const total = rows ? payoutTotal(rows) : 0
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <div className="flex items-center gap-2"><Wallet size={22} /><h1 className="text-xl font-bold text-gray-900">Видати зарплату за сьогодні</h1></div>
      <p className="text-sm text-gray-600">Видайте заробіток перед закриттям зміни. Якщо в касі бракує готівки, а власник доніс свої гроші — «Коштами власника».</p>
      {error && <Card className="p-4"><p role="alert" className="text-sm text-red-700">{error}</p><Button className="mt-2" size="sm" variant="secondary" onClick={() => void load()}>Повторити</Button></Card>}
      {!rows && !error && <p role="status" className="text-sm text-gray-500">Завантаження…</p>}
      {rows && (
        <Card className="divide-y">
          {rows.length === 0 && <p className="p-4 text-sm text-gray-500">Немає працівників для виплати.</p>}
          {rows.map(row => (
            <div key={row.employee_id} className="flex flex-wrap items-center gap-3 p-4" data-payout-row={row.employee_id}>
              <div className="min-w-[10rem] flex-1">
                <p className="font-semibold text-gray-900">{row.employee_name}</p>
                <p className="text-xs text-gray-500">
                  Зароблено {formatMoney(row.earned + row.pending_day_rate)}{row.paid > 0 ? ` · видано ${formatMoney(row.paid)}` : ''}{row.penalty > 0 ? ` · штраф ${formatMoney(row.penalty)}` : ''}
                </p>
              </div>
              <p className={`text-lg font-bold ${row.due > 0 ? 'text-gray-900' : 'text-gray-400'}`}>{row.due > 0 ? formatMoney(row.due) : 'видано'}</p>
              {row.due > 0 && (
                <div className="flex gap-2">
                  <Button size="sm" loading={busy === row.employee_id} disabled={!!busy} onClick={() => void pay(row, 'cashbox')}>З каси</Button>
                  <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void pay(row, 'owner_funds')}>Коштами власника</Button>
                </div>
              )}
            </div>
          ))}
          {rows.length > 0 && <p className="p-4 text-right text-sm text-gray-700">Разом до видачі: <b>{formatMoney(total)}</b></p>}
        </Card>
      )}
    </div>
  )
}
