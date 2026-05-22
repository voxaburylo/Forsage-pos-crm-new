import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, DollarSign, TrendingUp, Award, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Card, Button, Modal, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'

interface Employee { id: string; email: string; user_metadata: { full_name?: string; role?: string } }

interface SalaryPayment {
  id: string
  employee_id: string
  employee_name: string
  amount: number
  type: 'salary' | 'bonus' | 'advance' | 'penalty'
  method: string
  period: string
  note: string | null
  created_at: string
}

interface EmployeeSummary {
  employee_id: string
  employee_name: string
  salary: number
  bonus: number
  advance: number
  penalty: number
  total: number
}

const TYPE_CONFIG = {
  salary:  { label: 'Зарплата',  color: 'bg-green-100 text-green-700',  icon: <DollarSign size={12} /> },
  bonus:   { label: 'Бонус',     color: 'bg-yellow-100 text-yellow-700', icon: <Award size={12} /> },
  advance: { label: 'Аванс',     color: 'bg-blue-100 text-blue-700',     icon: <TrendingUp size={12} /> },
  penalty: { label: 'Штраф',     color: 'bg-red-100 text-red-700',       icon: <AlertTriangle size={12} /> },
}

const METHOD_LABELS: Record<string, string> = { cash: 'Готівка', card: 'Картка', transfer: 'Переказ' }

function currentPeriod() { return new Date().toISOString().slice(0, 7) }
function periodLabel(p: string) {
  const [y, m] = p.split('-')
  const months = ['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень']
  return `${months[parseInt(m) - 1]} ${y}`
}

export default function StaffSalaryPage() {
  const [period, setPeriod]       = useState(currentPeriod())
  const [payments, setPayments]   = useState<SalaryPayment[]>([])
  const [summary, setSummary]     = useState<EmployeeSummary[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading]     = useState(true)
  const [modal, setModal]         = useState(false)
  const [saving, setSaving]       = useState(false)
  const [filterEmp, setFilterEmp] = useState('')

  const [form, setForm] = useState({
    employee_id: '', amount: '', type: 'salary' as const,
    method: 'cash', note: '', period: currentPeriod(),
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [p, s] = await Promise.all([
        api.get<{ data: SalaryPayment[] }>(`/api/v1/salary?period=${period}`),
        api.get<{ data: EmployeeSummary[] }>(`/api/v1/salary/summary?period=${period}`),
      ])
      setPayments(p.data ?? [])
      setSummary(s.data ?? [])
    } catch { toast.error('Помилка завантаження') }
    finally { setLoading(false) }
  }, [period])

  useEffect(() => {
    load()
    api.get<{ data: Employee[] }>('/api/v1/admin/users').then((r) => setEmployees(r.data ?? [])).catch(() => {})
  }, [load])

  function getEmployeeName(id: string) {
    const e = employees.find((e) => e.id === id)
    return e?.user_metadata?.full_name ?? e?.email ?? id
  }

  async function handleCreate() {
    if (!form.employee_id) { toast.error('Виберіть співробітника'); return }
    const amount = Math.round(parseFloat(form.amount || '0') * 100)
    if (amount <= 0) { toast.error('Вкажіть суму'); return }

    setSaving(true)
    try {
      await api.post('/api/v1/salary', {
        employee_id:   form.employee_id,
        employee_name: getEmployeeName(form.employee_id),
        amount,
        type:   form.type,
        method: form.method,
        period: form.period || period,
        note:   form.note.trim() || null,
      })
      toast.success('Нарахування збережено')
      setModal(false)
      setForm({ employee_id: '', amount: '', type: 'salary', method: 'cash', note: '', period: currentPeriod() })
      load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
    finally { setSaving(false) }
  }

  async function handleDelete(id: string) {
    try {
      await api.delete(`/api/v1/salary/${id}`)
      toast.success('Видалено')
      load()
    } catch { toast.error('Помилка') }
  }

  const filtered = filterEmp ? payments.filter((p) => p.employee_id === filterEmp) : payments
  const totalMonth = summary.reduce((s, e) => s + e.total, 0)

  // Period navigation
  function shiftPeriod(delta: number) {
    const [y, m] = period.split('-').map(Number)
    const d = new Date(y, m - 1 + delta, 1)
    setPeriod(d.toISOString().slice(0, 7))
  }

  return (
    <Layout
      title="Нарахування зарплати"
      actions={
        <Button icon={<Plus size={16} />} onClick={() => setModal(true)}>
          Нарахування
        </Button>
      }
    >
      <div className="max-w-5xl space-y-5">

        {/* Period selector */}
        <div className="flex items-center gap-3">
          <button onClick={() => shiftPeriod(-1)} className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm hover:bg-gray-50">←</button>
          <span className="font-semibold text-gray-800 text-lg">{periodLabel(period)}</span>
          <button onClick={() => shiftPeriod(1)} className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm hover:bg-gray-50">→</button>
          <span className="ml-auto text-sm text-gray-500">
            Всього за місяць: <span className="font-bold text-gray-900">{formatMoney(totalMonth)}</span>
          </span>
        </div>

        {/* Зведення по співробітниках */}
        {summary.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {summary.map((e) => (
              <button
                key={e.employee_id}
                onClick={() => setFilterEmp(filterEmp === e.employee_id ? '' : e.employee_id)}
                className={`text-left bg-white rounded-xl border p-4 transition-all ${
                  filterEmp === e.employee_id
                    ? 'border-yellow-400 shadow-md'
                    : 'border-gray-100 hover:border-gray-300'
                }`}
              >
                <p className="font-semibold text-gray-900 text-sm mb-2">{e.employee_name}</p>
                <div className="space-y-1 text-xs text-gray-500">
                  {e.salary  > 0 && <div className="flex justify-between"><span>Зарплата</span><span className="font-medium text-gray-700">{formatMoney(e.salary)}</span></div>}
                  {e.bonus   > 0 && <div className="flex justify-between"><span>Бонус</span><span className="font-medium text-yellow-600">{formatMoney(e.bonus)}</span></div>}
                  {e.advance > 0 && <div className="flex justify-between"><span>Аванс</span><span className="font-medium text-blue-600">{formatMoney(e.advance)}</span></div>}
                  {e.penalty > 0 && <div className="flex justify-between"><span>Штраф</span><span className="font-medium text-red-600">−{formatMoney(e.penalty)}</span></div>}
                </div>
                <div className="mt-2 pt-2 border-t border-gray-100 flex justify-between">
                  <span className="text-xs text-gray-400">Разом</span>
                  <span className={`text-sm font-bold ${e.total >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                    {formatMoney(e.total)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Список нарахувань */}
        <Card padding="none">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <span className="font-semibold text-gray-800 text-sm">
              {filterEmp ? `${getEmployeeName(filterEmp)} — деталі` : 'Всі нарахування'}
            </span>
            {filterEmp && (
              <button onClick={() => setFilterEmp('')} className="text-xs text-gray-400 hover:text-gray-600">
                Показати всіх
              </button>
            )}
          </div>

          {loading ? (
            <p className="text-center py-10 text-gray-400 text-sm">Завантаження...</p>
          ) : filtered.length === 0 ? (
            <p className="text-center py-10 text-gray-400 text-sm">Нарахувань за цей період немає</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {filtered.map((p) => {
                const tc = TYPE_CONFIG[p.type]
                return (
                  <div key={p.id} className="px-5 py-3 flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-medium text-gray-900 text-sm">{p.employee_name}</span>
                        <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${tc.color}`}>
                          {tc.icon} {tc.label}
                        </span>
                        <span className="text-[10px] text-gray-400">{METHOD_LABELS[p.method]}</span>
                      </div>
                      {p.note && <p className="text-xs text-gray-400 truncate">{p.note}</p>}
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`font-bold text-sm ${p.type === 'penalty' ? 'text-red-600' : 'text-gray-900'}`}>
                        {p.type === 'penalty' ? '−' : '+'}{formatMoney(p.amount)}
                      </p>
                      <p className="text-[10px] text-gray-400">
                        {new Date(p.created_at).toLocaleDateString('uk-UA')}
                      </p>
                    </div>
                    <button
                      onClick={() => handleDelete(p.id)}
                      className="text-gray-300 hover:text-red-400 shrink-0 transition-colors"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Модал нового нарахування */}
      <Modal open={modal} onClose={() => setModal(false)} title="Нове нарахування" size="sm">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Співробітник *</label>
            <select
              value={form.employee_id}
              onChange={(e) => setForm({ ...form, employee_id: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">— Виберіть —</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.user_metadata?.full_name ?? e.email} ({e.user_metadata?.role ?? '—'})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Тип</label>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as any })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="salary">Зарплата</option>
                <option value="bonus">Бонус</option>
                <option value="advance">Аванс</option>
                <option value="penalty">Штраф</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Метод</label>
              <select
                value={form.method}
                onChange={(e) => setForm({ ...form, method: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="cash">Готівка</option>
                <option value="card">Картка</option>
                <option value="transfer">Переказ</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Сума (грн) *"
              type="number" min="0.01" step="0.01"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              placeholder="5000"
            />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Місяць</label>
              <input
                type="month"
                value={form.period}
                onChange={(e) => setForm({ ...form, period: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Примітка</label>
            <textarea
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              rows={2}
              placeholder="За що нараховано..."
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
            />
          </div>

          <div className="flex gap-3">
            <Button onClick={handleCreate} loading={saving} className="flex-1">
              Зберегти
            </Button>
            <Button variant="secondary" onClick={() => setModal(false)}>Скасувати</Button>
          </div>
        </div>
      </Modal>
    </Layout>
  )
}
