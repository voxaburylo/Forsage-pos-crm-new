import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Trash2, X } from 'lucide-react'
import { writeoffApi } from './writeoffApi'
import { REASON_LABEL } from '@/types/writeoff'
import type { WriteoffReason } from '@/types/writeoff'
import type { Product } from '@/types/product'
import { Layout } from '@/components/Layout'
import { Button, Card } from '@/components/ui'
import { ProductAutocomplete } from '@/components/ProductAutocomplete'
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
  const [saving, setSaving]   = useState(false)

  const hasDraft = items.length > 0 || notes.trim().length > 0
  const totalQty = items.reduce((sum, item) => sum + Number(item.qty || 0), 0)

  function closeForm() {
    if (hasDraft && !confirm('Закрити акт списання без проведення?\n\nДані з цього вікна не будуть збережені.')) return
    navigate('/inventory/writeoffs')
  }

  function addProduct(p: Product) {
    if (items.some((i) => i.product_id === p.id)) {
      toast.warning('Цей товар вже додано')
      return
    }
    setItems((prev) => [...prev, {
      product_id:   p.id,
      product_name: p.name,
      product_sku:  p.sku,
      unit:         p.unit ?? 'шт',
      qty_on_hand:  (p as any).qty_available ?? p.qty_on_hand ?? 0,
      qty:          1,
    }])
    setSearch('')
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
      toast.success('Акт списання проведено')
      navigate('/inventory/writeoffs/' + res.data.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка проведення списання')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Layout
      title="Новий акт списання"
      onBack={closeForm}
      actions={
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" icon={<X size={15} />} onClick={closeForm}>
            Закрити
          </Button>
          <Button type="submit" form="writeoff-form" disabled={saving || items.length === 0}>
            {saving ? 'Проводимо...' : 'Провести списання'}
          </Button>
        </div>
      }
    >
      <form id="writeoff-form" onSubmit={handleSubmit} className="max-w-5xl pb-24">
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Акт списання проводиться одразу: після натискання залишки товарів будуть зменшені, а рух товару буде записаний в історію.
        </div>

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

        <Card padding="none" className="mb-4">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-gray-800">Товари ({items.length})</span>
            {items.length > 0 && <span className="text-xs text-gray-400">До списання: {totalQty}</span>}
          </div>
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
            <ProductAutocomplete
              value={search}
              onChange={setSearch}
              onSelect={addProduct}
              warehouseOnly
              placeholder="Пошук товару для списання..."
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="text-xs text-gray-500 uppercase border-b border-gray-100">
                  <th className="text-left px-4 py-2">Товар</th>
                  <th className="text-right px-2 py-2 w-28">Залишок</th>
                  <th className="text-right px-2 py-2 w-32">Списати</th>
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
                    <td className="px-2 py-2 text-right text-gray-500 whitespace-nowrap">
                      {item.qty_on_hand} {item.unit}
                    </td>
                    <td className="px-2 py-2">
                      <input type="number" step="0.001" min="0.001" max={item.qty_on_hand}
                        value={item.qty}
                        onChange={(e) => updateQty(i, e.target.value)}
                        className={
                          'w-full text-right border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 ' +
                          (item.qty > item.qty_on_hand ? 'border-red-400 bg-red-50' : 'border-gray-200')
                        } />
                    </td>
                    <td className="px-2 py-2">
                      <button type="button" onClick={() => removeItem(i)}
                        className="text-red-300 hover:text-red-500 p-2">
                        <Trash2 size={15} />
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
          </div>
        </Card>

        <div className="sticky bottom-0 z-20 -mx-2 border-t border-gray-200 bg-white/95 px-2 py-3 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur sm:rounded-xl sm:border sm:px-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-gray-600">
              <span className="font-semibold text-gray-900">{items.length}</span> позицій · до списання <span className="font-semibold text-gray-900">{totalQty}</span>
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" onClick={closeForm}>
                Закрити
              </Button>
              <Button type="submit" disabled={saving || items.length === 0}>
                {saving ? 'Проводимо...' : 'Провести списання'}
              </Button>
            </div>
          </div>
        </div>
      </form>
    </Layout>
  )
}
