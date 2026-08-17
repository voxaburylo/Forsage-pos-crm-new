import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, CreditCard, Trash2 } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button, Card, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { adminApi, ROLE_LABELS } from '@/features/admin/adminApi'
import type { AdminUser, UserRole } from '@/features/admin/adminApi'
import { staffApi } from '@/features/staff/staffApi'
import type { DailySummary, EmployeeSummary, SalaryPayment, SalaryFundSource } from '@/features/staff/staffApi'
import { shiftApi } from '@/features/pos/shiftApi'
import { formatMoney } from '@/lib/utils'

type OperationType = SalaryPayment['type']
type PaymentMethod = SalaryPayment['method']
const OPERATION_LABELS: Record<OperationType, string> = {
  salary: 'Ставка',
  bonus: 'Премія',
  advance: 'Виплата / аванс',
  penalty: 'Штраф',
}

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Готівка',
  card: 'Картка',
  transfer: 'Переказ',
}

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7)
}

function localDate(): string {
  const date = new Date()
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function periodLabel(period: string): string {
  const [year, month] = period.split('-').map(Number)
  return new Date(year, month - 1, 1).toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' })
}

export default function PayrollPage() {
  const [period, setPeriod] = useState(currentPeriod())
  const [users, setUsers] = useState<AdminUser[]>([])
  const [summary, setSummary] = useState<EmployeeSummary[]>([])
  const [payments, setPayments] = useState<SalaryPayment[]>([])
  const [daily, setDaily] = useState<DailySummary[]>([])
  const [selected, setSelected] = useState<AdminUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    type: 'advance' as OperationType,
    method: 'cash' as PaymentMethod,
    amount: '',
    note: '',
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [usersResult, summaryResult, paymentsResult, dailyResult] = await Promise.all([
        adminApi.listUsers(),
        staffApi.summary(period),
        staffApi.listSalary(period),
        staffApi.dailySummary(localDate()),
      ])
      setUsers((usersResult.data ?? []).filter((user) => user.is_active && user.role !== 'owner'))
      setSummary(summaryResult.data ?? [])
      setPayments(paymentsResult.data ?? [])
      setDaily(dailyResult.data ?? [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося завантажити зарплату')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => {
    void load()
  }, [load])

  const summaryByEmployee = useMemo(
    () => new Map(summary.map((row) => [row.employee_id, row])),
    [summary],
  )
  const selectedSummary = selected ? summaryByEmployee.get(selected.id) : undefined
  const selectedDaily = selected ? daily.find((row) => row.employee_id === selected.id) : undefined
  const selectedPayments = selected ? payments.filter((row) => row.employee_id === selected.id) : []
  const totals = summary.reduce(
    (result, row) => ({
      earned: result.earned + Number(row.earned ?? 0),
      paid: result.paid + Number(row.paid ?? 0),
      balance: result.balance + Number(row.balance ?? 0),
    }),
    { earned: 0, paid: 0, balance: 0 },
  )

  function shiftPeriod(delta: number) {
    const [year, month] = period.split('-').map(Number)
    const date = new Date(year, month - 1 + delta, 1)
    setPeriod(date.toISOString().slice(0, 7))
  }

  async function currentShiftId(): Promise<string> {
    const result = await shiftApi.current()
    const shiftId = (result as { data?: { id?: string } })?.data?.id
    if (!shiftId) throw new Error('Спочатку відкрийте касову зміну')
    return shiftId
  }

  async function createOperation() {
    if (!selected) return
    const amount = Math.round(Number(form.amount) * 100)
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Вкажіть коректну суму')
      return
    }
    setSaving(true)
    try {
      const shiftId = form.type === 'advance' && form.method === 'cash'
        ? await currentShiftId()
        : null
      await staffApi.createSalary({
        employee_id: selected.id,
        employee_name: selected.full_name || selected.email,
        amount,
        type: form.type,
        method: form.method,
        period,
        note: form.note.trim() || null,
        shift_id: shiftId,
        work_date: localDate(),
      })
      setForm((value) => ({ ...value, amount: '', note: '' }))
      toast.success('Операцію збережено')
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти операцію')
    } finally {
      setSaving(false)
    }
  }

  async function payDaily(fundSource: SalaryFundSource) {
    if (!selected) return
    if (fundSource === 'owner_funds' && !window.confirm('Виплатити заробіток власними коштами? Залишок каси не зміниться.')) return
    setSaving(true)
    try {
      const shiftId = await currentShiftId()
      const result = await staffApi.dailyPayout({
        employee_id: selected.id,
        employee_name: selected.full_name || selected.email,
        method: 'cash',
        fund_source: fundSource,
        shift_id: shiftId,
        work_date: localDate(),
      })
      toast.success('Виплачено ' + formatMoney(result.data.amount))
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося провести виплату')
    } finally {
      setSaving(false)
    }
  }

  async function deleteOperation(id: string) {
    if (!window.confirm('Видалити цю операцію?')) return
    try {
      await staffApi.deleteSalary(id)
      await load()
      toast.success('Операцію видалено')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося видалити операцію')
    }
  }

  return (
    <Layout title="Зарплата та виплати">
      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => shiftPeriod(-1)} className="rounded-lg border border-gray-200 bg-white p-2 hover:bg-gray-50"><ChevronLeft size={16} /></button>
        <strong className="min-w-[170px] text-center capitalize">{periodLabel(period)}</strong>
        <button onClick={() => shiftPeriod(1)} className="rounded-lg border border-gray-200 bg-white p-2 hover:bg-gray-50"><ChevronRight size={16} /></button>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card><p className="text-xs text-gray-500">Нараховано</p><p className="mt-1 text-2xl font-bold text-gray-900">{formatMoney(totals.earned)}</p></Card>
        <Card><p className="text-xs text-gray-500">Виплачено</p><p className="mt-1 text-2xl font-bold text-blue-700">{formatMoney(totals.paid)}</p></Card>
        <Card><p className="text-xs text-gray-500">До виплати</p><p className="mt-1 text-2xl font-bold text-amber-700">{formatMoney(totals.balance)}</p></Card>
      </div>

      <Card padding="none">
        <div className="overflow-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr><th className="px-4 py-3 text-left">Працівник</th><th className="px-2 py-3 text-left">Роль</th><th className="px-2 py-3 text-right">Нараховано</th><th className="px-2 py-3 text-right">Виплачено</th><th className="px-2 py-3 text-right">До виплати</th><th className="px-4 py-3 text-right"></th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">Завантаження…</td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">Працівників не знайдено</td></tr>
              ) : users.map((user) => {
                const row = summaryByEmployee.get(user.id)
                return (
                  <tr key={user.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-semibold text-gray-900">{user.full_name || user.email}</td>
                    <td className="px-2 py-3 text-gray-500">{ROLE_LABELS[user.role as UserRole] ?? user.role}</td>
                    <td className="px-2 py-3 text-right">{formatMoney(row?.earned ?? 0)}</td>
                    <td className="px-2 py-3 text-right">{formatMoney(row?.paid ?? 0)}</td>
                    <td className="px-2 py-3 text-right font-bold text-amber-700">{formatMoney(row?.balance ?? 0)}</td>
                    <td className="px-4 py-3 text-right"><Button size="sm" variant="secondary" onClick={() => setSelected(user)}><CreditCard size={14} /> Операції</Button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected?.full_name || 'Виплати'} size="xl">
        {selected && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Card><p className="text-xs text-gray-400">Нараховано</p><strong>{formatMoney(selectedSummary?.earned ?? 0)}</strong></Card>
              <Card><p className="text-xs text-gray-400">Виплачено</p><strong>{formatMoney(selectedSummary?.paid ?? 0)}</strong></Card>
              <Card><p className="text-xs text-gray-400">До виплати</p><strong className="text-amber-700">{formatMoney(selectedSummary?.balance ?? 0)}</strong></Card>
              <Card><p className="text-xs text-gray-400">Сьогодні</p><strong>{formatMoney(selectedDaily?.balance ?? 0)}</strong></Card>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Button loading={saving} onClick={() => payDaily('cashbox')}>Видати денний заробіток з каси</Button>
              <Button loading={saving} variant="secondary" onClick={() => payDaily('owner_funds')}>Видати коштами власника</Button>
            </div>
            <div className="grid grid-cols-1 gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4 sm:grid-cols-2">
              <select value={form.type} onChange={(event) => setForm((value) => ({ ...value, type: event.target.value as OperationType }))} className="rounded-lg border border-gray-200 bg-white px-3 py-2"><option value="salary">Нарахувати ставку</option><option value="bonus">Премія</option><option value="advance">Виплата / аванс</option><option value="penalty">Штраф</option></select>
              <select value={form.method} onChange={(event) => setForm((value) => ({ ...value, method: event.target.value as PaymentMethod }))} className="rounded-lg border border-gray-200 bg-white px-3 py-2"><option value="cash">Готівка</option><option value="card">Картка</option><option value="transfer">Переказ</option></select>
              <input type="number" min="0.01" step="0.01" value={form.amount} onChange={(event) => setForm((value) => ({ ...value, amount: event.target.value }))} placeholder="Сума, грн" className="rounded-lg border border-gray-200 bg-white px-3 py-2" />
              <input value={form.note} onChange={(event) => setForm((value) => ({ ...value, note: event.target.value }))} placeholder="Примітка" className="rounded-lg border border-gray-200 bg-white px-3 py-2" />
              <Button loading={saving} onClick={createOperation} className="sm:col-span-2">Зберегти операцію</Button>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-bold text-gray-900">Операції за місяць</h3>
              <div className="max-h-64 divide-y divide-gray-100 overflow-auto rounded-xl border border-gray-200">
                {selectedPayments.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-gray-400">Операцій за цей місяць немає</p>
                ) : selectedPayments.map((payment) => (
                  <div key={payment.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900">{OPERATION_LABELS[payment.type]}</p>
                      <p className="text-xs text-gray-400">
                        {new Date(payment.created_at).toLocaleString('uk-UA')} · {PAYMENT_LABELS[payment.method]}
                        {payment.note ? ` · ${payment.note}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <strong>{formatMoney(payment.amount)}</strong>
                      <button type="button" onClick={() => deleteOperation(payment.id)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-red-500 hover:bg-red-50"
                        title="Видалити операцію">
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </Layout>
  )
}
