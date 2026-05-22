import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Trash2 } from 'lucide-react'
import { writeoffApi } from './writeoffApi'
import { productApi } from '@/features/products/productApi'
import { REASON_LABEL } from '@/types/writeoff'
import type { WriteoffReason } from '@/types/writeoff'
import type { Product } from '@/types/product'
import { Layout } from '@/components/Layout'
import { Button, Card, SearchInput } from '@/components/ui'
import { toast } from '@/components/ui/Toast'


interface LineItem {
  product_id:   string
  product_name: string
  product_sku:  string
  unit:         string
  qty_on_hand:  number
  qty:          number
}

const REASONS = ['damage', 'expiry', 'loss', 'audit', 'other'] as const

export default function WriteoffFormPage() {
  const navigate = useNavigate()
  const [reason, setReason]   = useState<WriteoffReason>('damage')
  const [notes, setNotes]     = useState('')
  const [items, setItems]     = useState<LineItem[]>([])
  const [search, setSearch]   = useState('')
  const [results, setResults] = useState<Product[]>([])
  const [saving, setSaving]   = useState(false)

  const searchProducts = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return }
    try {
      const res = await productApi.list({ search: q, per_page: 10 })
      setResults(res.data)
    } catch { setResults([]) }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => searchProducts(search), 300)
    return () => clearTimeout(t)
  }, [search, searchProducts])

  function addProduct(p: Product) {
    if (items.some((i) => i.product_id === p.id)) {
      toast.warning('Цей товар вже додано')
      return
    }
    setItems((prev) => [...prev, {
      product_id:   p.id,
      product_name: p.name,
      product_sku:  p.sku,
      unit:         p.unit,
      qty_on_hand:  p.qty_on_hand,
      qty:          1,
    }])
    setSearch('')
    setResults([])
  }

  function updateQty(index: number, value: string) {
    const num = parseFloat(value) || 0
    setItems((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], qty: Math.min(num, next[index].qty_on_hand) }
      return next
    })
  }

  function removeItem(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  function validate(): string | null {
    if (items.length === 0) return 'Додайте хоча б один товар'
    for (const item of items) {
      if (item.qty <= 0) return 'Кількість має бути > 0 для "' + item.product_name + '"'
      if (item.qty > item.qty_on_hand) return 'Недостатньо залишку для "' + item.product_name + '"'
    }
    return null
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const err = validate()
    if (err) { toast.error(err); return }

    setSaving(true)
    try {
      const res = await writeoffApi.create({
        reason,
        notes: notes.trim() || null,
        items: items.map((i) => ({ product_id: i.product_id, qty: i.qty })),
      })
      toast.success('Акт списання створено')
      navigate('/inventory/writeoffs/' + res.data.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка збереження')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Layout title="Новий акт списання" onBack={() => navigate('/inventory/writeoffs')}>
      <form onSubmit={handleSubmit} className="max-w-3xl">

        {/* Загальне */}
        <Card className="mb-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Причина *</label>
              <select value={reason} onChange={(e) => setReason(e.target.value as WriteoffReason)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400">
                {REASONS.map((r) => (
                  <option key={r} value={r}>{REASON_LABEL[r]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Нотатки</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 resize-none"
                placeholder="Причина детально..." />
            </div>
          </div>
        </Card>

        {/* Пошук товарів */}
        <Card padding="none" className="mb-4">
          <div className="px-4 py-3 border-b border-gray-100">
            <span className="text-sm font-semibold text-gray-800">Товари ({items.length})</span>
          </div>
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
            <SearchInput value={search} onChange={setSearch} placeholder="Пошук товару для списання..." />
            {results.length > 0 && (
              <div className="mt-2 max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-sm">
                {results.map((p) => (
                  <button key={p.id} type="button" onClick={() => addProduct(p)}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-yellow-50 flex items-center justify-between">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-gray-400 text-xs">{p.sku} — залишок: {p.qty_on_hand} {p.unit}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 uppercase border-b border-gray-100">
                <th className="text-left px-4 py-2">Товар</th>
                <th className="text-right px-2 py-2 w-28">Залишок</th>
                <th className="text-right px-2 py-2 w-28">Списати</th>
                <th className="w-10 px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={item.product_id} className="border-b border-gray-50 hover:bg-gray-50/50">
                  <td className="px-4 py-2">
                    <div className="font-medium">{item.product_name}</div>
                    <div className="text-xs text-gray-400">{item.product_sku}</div>
                  </td>
                  <td className="px-2 py-2 text-right text-gray-500">
                    {item.qty_on_hand} {item.unit}
                  </td>
                  <td className="px-2 py-2">
                    <input type="number" step="0.001" min="0.001" max={item.qty_on_hand}
                      value={item.qty}
                      onChange={(e) => updateQty(i, e.target.value)}
                      className={
                        'w-full text-right border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 ' +
                        (item.qty > item.qty_on_hand ? 'border-red-400 bg-red-50' : 'border-gray-200')
                      } />
                  </td>
                  <td className="px-2 py-2">
                    <button type="button" onClick={() => removeItem(i)}
                      className="text-red-300 hover:text-red-500 p-1">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-center text-gray-400 text-sm py-8">
                    Знайдіть та додайте товари через пошук вище
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>

        <div className="flex gap-3">
          <Button type="submit" disabled={saving || items.length === 0}>
            {saving ? 'Збереження...' : 'Створити акт списання'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate('/inventory/writeoffs')}>
            Скасувати
          </Button>
        </div>
      </form>
    </Layout>
  )
}
