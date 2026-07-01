import { useState, useEffect } from 'react'
import { Plus, TrendingDown } from 'lucide-react'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Card, Button, Modal, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDateTime } from '@/lib/utils'

interface ExpenseCategory {
  id: string
  name: string
  is_active: boolean
}

interface CashOp {
  id: string
  type: 'in' | 'out'
  amount: number
  note: string | null
  expense_category_id: string | null
  created_at: string
}

interface CashSummary {
  total_in: number
  total_out: number
  net: number
}

export default function CashflowPage() {
  const [ops, setOps] = useState<CashOp[]>([])
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [etype, setEtype] = useState<'in' | 'out'>('out')
  const [amount, setAmount] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [summary, setSummary] = useState<CashSummary>({ total_in: 0, total_out: 0, net: 0 })
  const [totalOps, setTotalOps] = useState(0)

  async function load() {
    try {
      const [opsRes, catRes, summaryRes] = await Promise.all([
        api.get<{ data: CashOp[]; total: number }>('/api/v1/cash-operations'),
        api.get<{ data: ExpenseCategory[] }>('/api/v1/expense-categories'),
        api.get<{ data: CashSummary }>('/api/v1/cash-operations/summary'),
      ])
      setOps(opsRes.data)
      setTotalOps(opsRes.total)
      setCategories(catRes.data)
      setSummary(summaryRes.data)
    } catch { toast.error('Помилка завантаження') }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  async function handleSave() {
    const kopecks = Math.round(parseFloat(amount || '0') * 100)
    if (kopecks <= 0) { toast.error('Вкажіть суму'); return }
    if (etype === 'out' && !categoryId) { toast.error('Виберіть категорію витрат'); return }
    setSaving(true)
    try {
      await api.post('/api/v1/cash-operations', {
        shift_id: null,
        type: etype,
        amount: kopecks,
        note: note.trim() || null,
        expense_category_id: etype === 'out' ? categoryId : null,
      })
      toast.success('Операцію збережено')
      setModalOpen(false); setAmount(''); setNote(''); setCategoryId('')
      load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
    finally { setSaving(false) }
  }

  return (
    <Layout title="Каса та витрати">
      <div className="max-w-4xl space-y-4">
        {/* Картки */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card className="bg-green-50 border-green-200">
            <p className="text-xs text-green-700 font-medium">Надходження</p>
            <p className="text-2xl font-bold text-green-800">{formatMoney(summary.total_in)}</p>
          </Card>
          <Card className="bg-red-50 border-red-200">
            <p className="text-xs text-red-700 font-medium">Витрати</p>
            <p className="text-2xl font-bold text-red-800">{formatMoney(summary.total_out)}</p>
          </Card>
          <Card className="bg-blue-50 border-blue-200">
            <p className="text-xs text-blue-700 font-medium">Баланс</p>
            <p className="text-2xl font-bold text-blue-800">{formatMoney(summary.net)}</p>
          </Card>
        </div>

        {/* Кнопки */}
        <div className="flex gap-3">
          <Button icon={<Plus size={16} />} onClick={() => { setEtype('in'); setModalOpen(true) }}>Внесення готівки</Button>
          <Button icon={<TrendingDown size={16} />} variant="secondary" onClick={() => { setEtype('out'); setModalOpen(true) }}>Витрата з каси</Button>
        </div>

        {/* Таблиця */}
        <Card padding="none">
          <table className="hidden md:table w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="text-xs text-gray-500 uppercase">
                <th className="text-left px-4 py-3">Тип</th>
                <th className="text-left px-4 py-3">Категорія</th>
                <th className="text-right px-4 py-3">Сума</th>
                <th className="text-left px-4 py-3">Примітка</th>
                <th className="text-right px-4 py-3">Час</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading ? (
                <tr><td colSpan={5} className="text-center text-gray-400 py-8">Завантаження...</td></tr>
              ) : ops.length === 0 ? (
                <tr><td colSpan={5} className="text-center text-gray-400 py-8">Немає операцій</td></tr>
              ) : ops.map((op) => {
                const cat = categories.find((c) => c.id === op.expense_category_id)
                return (
                  <tr key={op.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <span className={`font-medium ${op.type === 'in' ? 'text-green-600' : 'text-red-600'}`}>
                        {op.type === 'in' ? 'Внесення' : 'Витрата'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{cat?.name ?? (op.expense_category_id ? '—' : '—')}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${op.type === 'in' ? 'text-green-600' : 'text-red-600'}`}>
                      {op.type === 'in' ? '+' : '-'}{formatMoney(op.amount)}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{op.note ?? '—'}</td>
                    <td className="px-4 py-3 text-right text-gray-400 text-xs">{formatDateTime(op.created_at)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="md:hidden divide-y divide-gray-100">
            {loading ? (
              <div className="py-10 text-center text-sm text-gray-400">Завантаження...</div>
            ) : ops.length === 0 ? (
              <div className="py-10 text-center text-sm text-gray-400">Немає операцій</div>
            ) : ops.map((op) => {
              const category = categories.find((item) => item.id === op.expense_category_id)
              return (
                <div key={op.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className={`text-sm font-semibold ${op.type === 'in' ? 'text-green-600' : 'text-red-600'}`}>
                        {op.type === 'in' ? 'Внесення' : 'Витрата'}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">{category?.name ?? 'Без категорії'}</p>
                    </div>
                    <p className={`font-bold ${op.type === 'in' ? 'text-green-600' : 'text-red-600'}`}>
                      {op.type === 'in' ? '+' : '-'}{formatMoney(op.amount)}
                    </p>
                  </div>
                  {op.note && <p className="mt-2 text-xs leading-5 text-gray-600">{op.note}</p>}
                  <p className="mt-2 text-[11px] text-gray-400">{formatDateTime(op.created_at)}</p>
                </div>
              )
            })}
          </div>
          {totalOps > ops.length && (
            <p className="px-4 py-3 border-t border-gray-100 text-xs text-gray-500">
              Показано останні {ops.length} з {totalOps} операцій. Підсумки вище враховують увесь журнал.
            </p>
          )}
        </Card>
      </div>

      {/* Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={etype === 'in' ? 'Внесення готівки' : 'Витрата з каси'} size="sm">
        <div className="space-y-4">
          <Input label="Сума (грн) *" type="number" min="0.01" step="0.01" value={amount}
            onChange={(e) => setAmount(e.target.value)} placeholder="0.00" autoFocus />
          {etype === 'out' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Категорія витрат *</label>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
                <option value="">— Оберіть —</option>
                {categories.filter((c) => c.is_active).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}
          <Input label="Коментар" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Оплата за інтернет..." />
          <div className="flex gap-3">
            <Button onClick={handleSave} loading={saving} className="flex-1">Зберегти</Button>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>Скасувати</Button>
          </div>
        </div>
      </Modal>
    </Layout>
  )
}
