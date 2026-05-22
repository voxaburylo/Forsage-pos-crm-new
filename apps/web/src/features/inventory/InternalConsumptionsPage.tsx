import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Package, Search } from 'lucide-react'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Card, Button, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'

interface Employee { id: string; email: string; user_metadata: { full_name?: string; role?: string } }
interface Product  { id: string; name: string; sku: string | null; buy_price: number; qty_on_hand: number }

interface ConsumptionItem {
  product_id:   string | null
  product_name: string
  sku:          string | null
  qty:          number
  buy_price:    number
  total:        number
}

interface Consumption {
  id:            string
  employee_id:   string
  employee_name: string
  items:         ConsumptionItem[]
  total_cost:    number
  note:          string | null
  created_at:    string
}

interface Summary {
  employee_id:   string
  employee_name: string
  total_cost:    number
  items_count:   number
}

function currentMonth() { return new Date().toISOString().slice(0, 7) }
function monthLabel(m: string) {
  const [y, mo] = m.split('-')
  const months = ['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень']
  return `${months[parseInt(mo) - 1]} ${y}`
}

export default function InternalConsumptionsPage() {
  const [month, setMonth]               = useState(currentMonth())
  const [consumptions, setConsumptions] = useState<Consumption[]>([])
  const [summary, setSummary]           = useState<Summary[]>([])
  const [employees, setEmployees]       = useState<Employee[]>([])
  const [loading, setLoading]           = useState(true)
  const [modal, setModal]               = useState(false)
  const [saving, setSaving]             = useState(false)
  const [filterEmp, setFilterEmp]       = useState('')

  // Форма
  const [empId, setEmpId]       = useState('')
  const [note, setNote]         = useState('')
  const [formItems, setFormItems] = useState<Array<{
    product_id: string | null; product_name: string; sku: string | null
    qty: string; buy_price: number; search: string; results: Product[]
  }>>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, s] = await Promise.all([
        api.get<{ data: Consumption[] }>(`/api/v1/internal-consumptions?month=${month}`),
        api.get<{ data: Summary[] }>(`/api/v1/internal-consumptions/summary?month=${month}`),
      ])
      setConsumptions(c.data ?? [])
      setSummary(s.data ?? [])
    } catch { toast.error('Помилка завантаження') }
    finally { setLoading(false) }
  }, [month])

  useEffect(() => {
    load()
    api.get<{ data: Employee[] }>('/api/v1/admin/users').then((r) => setEmployees(r.data ?? [])).catch(() => {})
  }, [load])

  function getEmployeeName(id: string) {
    const e = employees.find((e) => e.id === id)
    return e?.user_metadata?.full_name ?? e?.email ?? id
  }

  function addFormItem() {
    setFormItems((prev) => [...prev, {
      product_id: null, product_name: '', sku: null,
      qty: '1', buy_price: 0, search: '', results: [],
    }])
  }

  function removeFormItem(i: number) {
    setFormItems((prev) => prev.filter((_, idx) => idx !== i))
  }

  async function searchProduct(i: number, q: string) {
    setFormItems((prev) => prev.map((item, idx) => idx === i ? { ...item, search: q } : item))
    if (q.trim().length < 2) {
      setFormItems((prev) => prev.map((item, idx) => idx === i ? { ...item, results: [] } : item))
      return
    }
    try {
      const r = await api.get<{ data: Product[] }>(`/api/v1/products?search=${encodeURIComponent(q)}&per_page=8`)
      setFormItems((prev) => prev.map((item, idx) => idx === i ? { ...item, results: r.data ?? [] } : item))
    } catch {
      /* ignore */
    }
  }

  function selectProduct(i: number, p: Product) {
    setFormItems((prev) => prev.map((item, idx) => idx === i ? {
      ...item,
      product_id:   p.id,
      product_name: p.name,
      sku:          p.sku,
      buy_price:    p.buy_price,
      search:       p.name,
      results:      [],
    } : item))
  }

  const totalCost = formItems.reduce((s, i) => s + i.buy_price * (parseInt(i.qty) || 1), 0)

  async function handleCreate() {
    if (!empId) { toast.error('Виберіть співробітника'); return }
    const validItems = formItems.filter((i) => i.product_name.trim() && i.buy_price >= 0)
    if (validItems.length === 0) { toast.error('Додайте хоча б одну позицію'); return }

    setSaving(true)
    try {
      await api.post('/api/v1/internal-consumptions', {
        employee_id:   empId,
        employee_name: getEmployeeName(empId),
        items: validItems.map((i) => ({
          product_id:   i.product_id,
          product_name: i.product_name.trim(),
          sku:          i.sku,
          qty:          parseInt(i.qty) || 1,
          buy_price:    i.buy_price,
        })),
        note: note.trim() || null,
      })
      toast.success('Відпуск збережено, залишки оновлено')
      setModal(false)
      setEmpId(''); setNote(''); setFormItems([])
      load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
    finally { setSaving(false) }
  }

  async function handleDelete(id: string) {
    try {
      await api.delete(`/api/v1/internal-consumptions/${id}`)
      toast.success('Видалено')
      load()
    } catch { toast.error('Помилка') }
  }

  function shiftMonth(delta: number) {
    const [y, m] = month.split('-').map(Number)
    const d = new Date(y, m - 1 + delta, 1)
    setMonth(d.toISOString().slice(0, 7))
  }

  const filtered = filterEmp ? consumptions.filter((c) => c.employee_id === filterEmp) : consumptions
  const totalMonth = summary.reduce((s, e) => s + e.total_cost, 0)

  return (
    <Layout
      title="Внутрішній відпуск (по собівартості)"
      actions={
        <Button icon={<Plus size={16} />} onClick={() => { setFormItems([{ product_id: null, product_name: '', sku: null, qty: '1', buy_price: 0, search: '', results: [] }]); setModal(true) }}>
          Видати запчастини
        </Button>
      }
    >
      <div className="max-w-5xl space-y-5">

        {/* Period selector */}
        <div className="flex items-center gap-3">
          <button onClick={() => shiftMonth(-1)} className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm hover:bg-gray-50">←</button>
          <span className="font-semibold text-gray-800 text-lg">{monthLabel(month)}</span>
          <button onClick={() => shiftMonth(1)} className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm hover:bg-gray-50">→</button>
          <span className="ml-auto text-sm text-gray-500">
            Собівартість за місяць: <span className="font-bold text-gray-900">{formatMoney(totalMonth)}</span>
          </span>
        </div>

        {/* Зведення по співробітниках */}
        {summary.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
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
                <p className="font-semibold text-gray-900 text-sm truncate">{e.employee_name}</p>
                <p className="text-xs text-gray-400 mt-1">{e.items_count} шт.</p>
                <p className="text-base font-bold text-red-600 mt-1">{formatMoney(e.total_cost)}</p>
              </button>
            ))}
          </div>
        )}

        {/* Список */}
        <Card padding="none">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <span className="font-semibold text-gray-800 text-sm">
              {filterEmp ? `${getEmployeeName(filterEmp)} — деталі` : 'Всі відпуски'}
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
            <p className="text-center py-10 text-gray-400 text-sm">Відпусків за цей період немає</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {filtered.map((c) => (
                <div key={c.id} className="px-5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-gray-900 text-sm">{c.employee_name}</span>
                        <span className="text-xs text-gray-400">
                          {new Date(c.created_at).toLocaleDateString('uk-UA')}
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        {c.items.map((item, i) => (
                          <p key={i} className="text-xs text-gray-500">
                            <span className="font-medium text-gray-700">{item.product_name}</span>
                            {item.sku && <span className="text-gray-400 font-mono ml-1">{item.sku}</span>}
                            <span className="ml-2">{item.qty} шт × {formatMoney(item.buy_price)}</span>
                            <span className="text-gray-400 ml-1">= {formatMoney(item.total)}</span>
                          </p>
                        ))}
                      </div>
                      {c.note && <p className="text-xs text-gray-400 mt-1 italic">{c.note}</p>}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="font-bold text-red-600 text-sm">{formatMoney(c.total_cost)}</span>
                      <button onClick={() => handleDelete(c.id)} className="text-gray-300 hover:text-red-400 transition-colors">
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Модал відпуску */}
      <Modal open={modal} onClose={() => setModal(false)} title="Відпуск запчастин по собівартості" size="lg">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Співробітник *</label>
            <select
              value={empId}
              onChange={(e) => setEmpId(e.target.value)}
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

          {/* Позиції */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-gray-700">Запчастини *</label>
              <button onClick={addFormItem} className="text-xs text-yellow-600 hover:text-yellow-700 font-medium flex items-center gap-1">
                <Plus size={12} /> Додати
              </button>
            </div>
            <div className="space-y-2">
              {formItems.map((item, i) => (
                <div key={i} className="border border-gray-200 rounded-xl p-3 space-y-2">
                  <div className="relative">
                    <div className="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2">
                      <Search size={14} className="text-gray-400 shrink-0" />
                      <input
                        value={item.search}
                        onChange={(e) => searchProduct(i, e.target.value)}
                        placeholder="Пошук товару по назві або артикулу..."
                        className="flex-1 text-sm focus:outline-none"
                      />
                    </div>
                    {item.results.length > 0 && (
                      <div className="absolute z-20 top-full mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
                        {item.results.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => selectProduct(i, p)}
                            className="w-full text-left px-4 py-2.5 hover:bg-yellow-50 text-sm border-b border-gray-50 last:border-0"
                          >
                            <span className="font-medium text-gray-900">{p.name}</span>
                            {p.sku && <span className="text-gray-400 font-mono ml-2 text-xs">{p.sku}</span>}
                            <span className="float-right text-gray-500">
                              Собів.: {formatMoney(p.buy_price)} · {p.qty_on_hand} шт
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 items-center">
                    <div className="flex-1 flex items-center gap-2 text-xs text-gray-500">
                      {item.buy_price > 0 && (
                        <span className="bg-gray-100 px-2 py-1 rounded">
                          Собів: <strong>{formatMoney(item.buy_price)}</strong>
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <label className="text-xs text-gray-500">К-сть:</label>
                      <input
                        type="number" min="1"
                        value={item.qty}
                        onChange={(e) => setFormItems((prev) => prev.map((it, idx) => idx === i ? { ...it, qty: e.target.value } : it))}
                        className="w-16 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-accent"
                      />
                    </div>
                    {item.buy_price > 0 && (
                      <span className="text-sm font-semibold text-red-600 w-24 text-right">
                        {formatMoney(item.buy_price * (parseInt(item.qty) || 1))}
                      </span>
                    )}
                    <button onClick={() => removeFormItem(i)} className="text-gray-300 hover:text-red-400">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
              {formItems.length === 0 && (
                <button onClick={addFormItem} className="w-full border-2 border-dashed border-gray-200 rounded-xl py-6 text-sm text-gray-400 hover:border-yellow-400 hover:text-yellow-600 transition-colors flex items-center justify-center gap-2">
                  <Package size={16} /> Натисніть щоб додати товар
                </button>
              )}
            </div>
          </div>

          {totalCost > 0 && (
            <div className="bg-red-50 rounded-xl px-4 py-3 flex justify-between items-center">
              <span className="text-sm text-red-700">Загальна собівартість:</span>
              <span className="font-bold text-red-700 text-lg">{formatMoney(totalCost)}</span>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Примітка</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Для яких цілей..."
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
            />
          </div>

          <div className="flex gap-3">
            <Button onClick={handleCreate} loading={saving} className="flex-1">
              Зберегти та списати зі складу
            </Button>
            <Button variant="secondary" onClick={() => setModal(false)}>Скасувати</Button>
          </div>
        </div>
      </Modal>
    </Layout>
  )
}
