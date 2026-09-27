import { useState } from 'react'
import type { ReactNode } from 'react'
import type { SalaryFundSource, TireServiceReport, TireServiceReportRow, TireSalaryOperation } from '@/features/staff/staffApi'
import { formatMoney } from '@/lib/utils'

const paymentNames: Record<string, string> = { cash: 'Готівка', card: 'Картка', transfer: 'Переказ', mixed: 'Змішана оплата', debt: 'Борг' }
export function tireOperationLabel(operation: TireSalaryOperation): string {
  if (operation.source === 'commission_reversal') return 'Сторно нарахування за повернення'
  if (operation.source === 'commission') return 'Нарахування за чек'
  if (operation.type === 'advance') return 'Виплата зарплати / аванс'
  if (operation.type === 'penalty') return 'Штраф / утримання'
  if (operation.source === 'daily_rate' || operation.type === 'salary') return 'Ставка'
  return 'Премія / додаткове нарахування'
}
function dateTime(value: string): string {
  return new Date(value).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function dayLabel(value: string): string {
  const [year, month, day] = value.split('-')
  return `${day}.${month}.${year}`
}
function AmountRow({ label, value, strong = false }: { label: ReactNode; value: number; strong?: boolean }) {
  return <div className={`flex flex-wrap justify-between gap-x-4 gap-y-1 py-1.5 ${strong ? 'border-t border-gray-200 pt-3 font-bold text-gray-900' : 'text-gray-700'}`}>
    <dt className="min-w-0">{label}</dt><dd className="font-semibold tabular-nums">{formatMoney(value)}</dd>
  </div>
}
interface Props {
  report: TireServiceReport | null
  date: string; today: string; employeeId: string; loading: boolean; error: boolean
  onDate: (date: string) => void; onEmployee: (id: string) => void; onRefresh: () => void
  canPay: boolean; canMutate: boolean; busy: boolean
  onHandOver: (row: TireServiceReportRow) => void
  onPay: (row: TireServiceReportRow, source: SalaryFundSource) => void
}
export function TireServiceDetails(props: Props) {
  const { report, date, employeeId, loading, error } = props
  const rows = report?.data.filter(row => !employeeId || row.employee_id === employeeId) ?? []
  return <section className="space-y-4" aria-label="Шиномонтаж: операції та зарплата">
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="text-lg font-bold text-gray-900">Шиномонтаж — роботи та зарплата</h2>
      <p className="mt-1 text-sm text-gray-500">Оберіть день робіт і працівника. Спочатку — чеки касира, нижче — нарахування, виплати та підсумок.</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-sm text-gray-600">Дата робіт<input aria-label="Дата робіт шиномонтажу" type="date" disabled={props.busy} max={props.today} value={date} onChange={e => props.onDate(e.target.value)} className="mt-1 block rounded-lg border border-gray-300 bg-white px-3 py-2" /></label>
        <label className="min-w-0 text-sm text-gray-600">Працівник<select aria-label="Працівник шиномонтажу" disabled={props.busy} value={employeeId} onChange={e => props.onEmployee(e.target.value)} className="mt-1 block w-full max-w-full rounded-lg border border-gray-300 bg-white px-3 py-2">
          <option value="">Усі шиномонтажники</option>{report?.data.map(row => <option key={row.employee_id} value={row.employee_id}>{row.employee_name}</option>)}
        </select></label>
        <button type="button" disabled={props.busy || loading || !date} onClick={props.onRefresh} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50">Оновити</button>
      </div>
    </div>
    {loading ? <p role="status" className="p-6 text-center text-gray-500">Завантажуємо операції…</p>
      : error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-800">Не вдалося завантажити звіт. Суми не показані, щоб не видати неповні дані за нуль. Натисніть «Оновити».</p>
      : !date ? <p className="p-4 text-gray-500">Оберіть дату робіт.</p>
      : report && <>
        {report.details_version !== 1 && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Джерело звіту ще не оновлено: касир, коментарі й деталізація нарахувань можуть бути недоступні.</p>}
        {rows.length === 0 && <p className="p-6 text-center text-gray-500">Для вибраного працівника даних немає.</p>}
        {rows.map(row => <WorkerDetails key={`${date}:${row.employee_id}`} row={row} {...props} report={report} />)}
      </>}
  </section>
}
function WorkerDetails({ row, report, date, canPay, canMutate, busy, onHandOver, onPay }: Props & { row: TireServiceReportRow; report: TireServiceReport }) {
  const [receiptLimit, setReceiptLimit] = useState(50)
  const [operationLimit, setOperationLimit] = useState(50)
  const receipts = report.receipts.filter(receipt => receipt.employee_id === row.employee_id)
  const salary = (report.salary_operations ?? []).filter(operation => operation.employee_id === row.employee_id)
  const handovers = (report.cash_handovers ?? []).filter(operation => operation.employee_id === row.employee_id)
  const operations = [
    ...salary.map(operation => ({ ...operation, key: 'salary-' + operation.id, label: tireOperationLabel(operation),
      detail: `${paymentNames[operation.method] ?? operation.method}${operation.fund_source === 'owner_funds' ? ' · кошти власника' : ''}` })),
    ...handovers.map(operation => ({ ...operation, key: 'cash-' + operation.id, label: 'Готівку передано до каси', detail: `За роботи ${dayLabel(operation.work_date)}` })),
  ].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.key.localeCompare(b.key))
  const otherEarned = row.earned - row.commission_earned - row.daily_rate
  return <article className="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white" aria-label={`Роботи та зарплата: ${row.employee_name}`}>
    <header className="flex flex-wrap justify-between gap-2 border-b border-gray-100 px-4 py-3">
      <div><h3 className="font-bold text-gray-900">{row.employee_name}</h3><p className="text-sm text-gray-500">{dayLabel(date)} · Чеків: {receipts.length}</p></div>
      <div className="text-right text-sm text-gray-600">Сума робіт<p className="text-lg font-bold text-gray-900">{formatMoney(row.service_revenue)}</p></div>
    </header>
    <div className="p-4">
      <h4 className="mb-3 font-semibold text-gray-900">Чеки касира</h4>
      {!receipts.length && <p className="text-sm text-gray-500">Закритих чеків за цей день немає.</p>}
      <div className="space-y-3">{receipts.slice(0, receiptLimit).map(receipt => <section key={receipt.id} className="rounded-lg border border-gray-200 p-3" aria-label={`Чек ${receipt.sale_number}`}>
        <div className="flex flex-wrap justify-between gap-2 text-sm"><strong>#{receipt.sale_number}</strong><span className="text-gray-500">{dateTime(receipt.completed_at)}</span></div>
        <p className="mt-1 text-sm text-gray-600">Касир: <span className="font-medium text-gray-900">{receipt.cashier_name || 'не вказаний у записі'}</span></p>
        <ul className="mt-2 space-y-1 text-sm">{receipt.services?.map(service => <li key={service.id} className="flex flex-wrap justify-between gap-x-3 gap-y-1">
          <span className="min-w-0 break-words">{service.description} · {Number(service.qty)} × {formatMoney(service.unit_price)}</span><strong>{formatMoney(service.total)}</strong>
        </li>)}</ul>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-gray-700"><span className="font-medium">Коментар: </span>{receipt.notes?.trim() || 'не заповнений'}</p>
        <div className="mt-3 flex flex-wrap justify-between gap-2 border-t border-gray-100 pt-2 text-sm"><span>{paymentNames[receipt.payment_method] ?? receipt.payment_method}</span><strong>Роботи: {formatMoney(receipt.service_revenue)}</strong></div>
        {receipt.commission_earned !== undefined && <p className="mt-1 text-sm text-emerald-800">Нараховано за цей чек: <strong>{formatMoney(receipt.commission_earned)}</strong></p>}
      </section>)}</div>
      {receiptLimit < receipts.length && <button type="button" className="mt-3 rounded-lg border px-3 py-2 text-sm" onClick={() => setReceiptLimit(value => value + 50)}>Ще чеки ({receipts.length - receiptLimit})</button>}
    </div>
    <div className="border-t border-gray-100 p-4">
      <h4 className="font-semibold text-gray-900">Нарахування, передача готівки та виплати</h4>
      <p className="mb-3 mt-1 text-xs text-gray-500">Операції прив’язані до дня робіт. Фактична передача грошей або виплата може бути пізніше.</p>
      {!operations.length && <p className="text-sm text-gray-500">{report.details_version === 1 ? 'Збережених операцій немає.' : 'Деталізація ще недоступна.'}</p>}
      <ol className="divide-y divide-gray-100">{operations.slice(0, operationLimit).map(operation => <li key={operation.key} className="py-3 text-sm">
        <div className="flex flex-wrap justify-between gap-2"><strong>{operation.label}</strong><strong>{formatMoney(operation.amount)}</strong></div>
        <p className="mt-1 text-xs text-gray-500">{dateTime(operation.created_at)} · Виконав: {operation.cashier_name || 'не вказано'} · {operation.detail}</p>
        {operation.note && <p className="mt-1 whitespace-pre-wrap break-words text-gray-700">{operation.note}</p>}
      </li>)}</ol>
      {operationLimit < operations.length && <button type="button" className="mt-3 rounded-lg border px-3 py-2 text-sm" onClick={() => setOperationLimit(value => value + 50)}>Ще операції ({operations.length - operationLimit})</button>}
    </div>
    <footer className="border-t border-gray-200 bg-gray-50 p-4" aria-label={`Розрахунок зарплати: ${row.employee_name}`}>
      <h4 className="mb-2 font-bold text-gray-900">Розрахунок зарплати за {dayLabel(date)}</h4>
      <dl className="text-sm">
        <AmountRow label="За чеками, з урахуванням сторно" value={row.commission_earned} />
        <AmountRow label={row.daily_rate_projected ? 'Ставка (ще не записана, попередній розрахунок)' : 'Ставка'} value={row.daily_rate} />
        {otherEarned !== 0 && <AmountRow label="Інші нарахування / премії" value={otherEarned} />}
        <AmountRow label="Усього нараховано" value={row.earned} strong />
        <AmountRow label="Утримання / штрафи" value={-row.penalty} />
        <AmountRow label="Уже виплачено" value={-row.paid} />
        <AmountRow label="Залишилося виплатити" value={row.due} strong />
      </dl>
      <p className="mt-3 text-xs text-gray-600">Готівка від робіт: {formatMoney(row.cash_revenue)} · передано до каси: {formatMoney(row.cash_handed_over)} · ще передати: {formatMoney(row.cash_pending)}.</p>
      {row.balance < 0 && <p className="mt-2 text-sm text-gray-600">Виплачено наперед: {formatMoney(-row.balance)}.</p>}
      {!row.salary_ready && <p className="mt-2 text-sm text-blue-800">Виплата за цими роботами доступна з {dayLabel(row.salary_available_on)} після передачі всієї готівки. Залишок зарплати не означає, що її вже можна видати сьогодні.</p>}
      {row.salary_ready && <p className="mt-2 font-bold text-emerald-800">Можна видати зараз: {formatMoney(row.payable_due)}</p>}
      {canMutate && <div className="mt-3 flex flex-wrap gap-2">
        {row.cash_pending > 0 && <button type="button" disabled={busy} onClick={() => onHandOver(row)} className="rounded-lg bg-yellow-400 px-3 py-2 text-sm font-semibold disabled:opacity-50">Внести готівку до каси</button>}
        {canPay && row.salary_ready && row.payable_due > 0 && <>
          <button type="button" disabled={busy} onClick={() => onPay(row, 'cashbox')} className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Виплатити з каси</button>
          <button type="button" disabled={busy} onClick={() => onPay(row, 'owner_funds')} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50">Виплатити коштами власника</button>
        </>}
      </div>}
    </footer>
  </article>
}
