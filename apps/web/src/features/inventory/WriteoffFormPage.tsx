import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Trash2, X } from 'lucide-react'
import { parseWriteoffQuantity, writeoffQuantityStep } from './writeoffQuantity'
import { writeoffApi } from './writeoffApi'
import { REASON_LABEL } from '@/types/writeoff'
import type { WriteoffReason } from '@/types/writeoff'
import type { Product } from '@/types/product'
import { Layout } from '@/components/Layout'
import { Button, Card } from '@/components/ui'
import { ProductAutocomplete } from '@/components/ProductAutocomplete'
import { useAuthStore } from '@/stores/authStore'
import { toast } from '@/components/ui/Toast'

interface LineItem {
  product_id:   string
  product_name: string
  product_sku:  string
  unit:         string
  qty_on_hand:  number
  qty:          number | string
}

const REASONS = ['damage', 'expiry', 'loss', 'audit', 'other'] as const

export default function WriteoffFormPage() {
  const navigate = useNavigate()
  const user = useAuthStore(state => state.session?.user)
  const draftKey = 'forsage:writeoff-draft:' + user?.id
  const [loaded] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem(draftKey) || '{}')
      if (!value || Array.isArray(value) || typeof value !== 'object'
        || (value.notes !== undefined && typeof value.notes !== 'string')
        || (value.reason !== undefined && !REASONS.includes(value.reason))
        || (value.operation_id !== undefined && (typeof value.operation_id !== 'string' || !value.operation_id || value.operation_id.length > 200))
        || (value.pending === true && !value.operation_id)
        || (value.items !== undefined && (!Array.isArray(value.items) || value.items.some((item: LineItem) => !item || typeof item.product_id !== 'string' || typeof item.product_name !== 'string')))) throw Error()
      return { draft: value, error: '' }
    } catch { return { draft: {}, error: 'Не вдалося прочитати чернетку списання. Не створюйте її повторно — потрібна перевірка збережених даних.' } }
  })
  const draft = loaded.draft
  const [operationId] = useState(() => typeof draft.operation_id === 'string' ? draft.operation_id : crypto.randomUUID())
  const finished = useRef(false)
  const busy = useRef(false)
  const [reason, setReason]   = useState<WriteoffReason>(draft.reason || 'damage')
  const [notes, setNotes]     = useState(draft.notes || '')
  const [items, setItems]     = useState<LineItem[]>(Array.isArray(draft.items) ? draft.items : [])
  const [search, setSearch]   = useState('')
  const [saving, setSaving]   = useState(false)
  const [pending, setPending] = useState(draft.pending === true)

  useEffect(() => {
    if (finished.current || loaded.error) return
    try { localStorage.setItem(draftKey, JSON.stringify({ reason, notes, items, operation_id: operationId, pending })) }
    catch { toast.error('Не вдалося зберегти чернетку. Не закривайте це вікно.') }
  }, [draftKey, reason, notes, items, operationId, pending, loaded.error])

  const hasDraft = items.length > 0 || notes.trim().length > 0
  const totalQty = items.reduce((sum, item) => sum + (parseWriteoffQuantity(item.qty) ?? 0), 0)

  function closeForm() {
    if (busy.current) return
    if (pending || loaded.error) { toast.error('Спочатку перевірте результат попередньої спроби списання.'); return }
    if (hasDraft && !confirm('Закрити акт списання без проведення?\n\nДані з цього вікна не будуть збережені.')) return
    try { localStorage.removeItem(draftKey) }
    catch { toast.error('Не вдалося прибрати чернетку. Вікно залишено відкритим.'); return }
    finished.current = true
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
      qty_on_hand:  p.qty_on_hand ?? p.qty_available ?? 0,
      qty:          1,
    }])
    setSearch('')
  }

  function updateQty(index: number, value: string) {
    setItems((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], qty: value }
      return next
    })
  }

  function removeItem(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  function validate(): string | null {
    if (items.length === 0) return 'Додайте хоча б один товар'
    for (const item of items) {
      if (parseWriteoffQuantity(item.qty) === null) return 'Кількість має бути > 0 для "' + item.product_name + '"'
    }
    return null
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy.current || pending || loaded.error) return
    const err = validate()
    if (err) { toast.error(err); return }

    busy.current = true
    setSaving(true)
    try {
      // Save the document's identity before dispatch so restoring an old draft cannot deduct twice.
      localStorage.setItem(draftKey, JSON.stringify({ reason, notes, items, operation_id: operationId, pending: true }))
      setPending(true)
      const res = await writeoffApi.create({
        operation_id: operationId,
        reason,
        notes: notes.trim() || null,
        items: items.map((i) => ({ product_id: i.product_id, qty: parseWriteoffQuantity(i.qty)! })),
      })
      finishWriteoff(res.data.id)
    } catch (err) {
      try {
        const saved = await writeoffApi.checkOperation(operationId)
        if (saved) finishWriteoff(saved.id)
        else { setPending(false); toast.error(err instanceof Error ? err.message : 'Помилка проведення списання') }
      } catch { setPending(true); toast.error('Результат списання не підтверджено. Натисніть «Перевірити списання» — не створюйте інший акт замість цього.') }
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  function finishWriteoff(id: string) {
    finished.current = true
    try { localStorage.removeItem(draftKey) } catch { /* The preserved pending marker forces a read-only status check. */ }
    toast.success('Акт списання проведено')
    navigate('/inventory/writeoffs/' + id)
  }

  async function checkPending() {
    if (busy.current) return
    busy.current = true; setSaving(true)
    try {
      const saved = await writeoffApi.checkOperation(operationId)
      if (saved) finishWriteoff(saved.id)
      else { setPending(false); toast.success('Цей акт не проведений. Можна перевірити рядки та провести.') }
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Не вдалося перевірити списання') }
    finally { busy.current = false; setSaving(false) }
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
          <Button type="submit" form="writeoff-form" disabled={saving || pending || !!loaded.error || items.length === 0}>
            {saving ? 'Проводимо...' : 'Провести списання'}
          </Button>
        </div>
      }
    >
      {loaded.error && <p role="alert" className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-red-800">{loaded.error}</p>}
      {pending && !loaded.error && <Card className="mb-4 max-w-5xl">
        <p role="alert" className="mb-3 text-sm text-amber-800">Є спроба списання без підтвердженого результату. Спочатку перевірте її, щоб не зменшити залишок двічі.</p>
        <Button type="button" loading={saving} onClick={checkPending}>Перевірити списання</Button>
      </Card>}
      <form id="writeoff-form" onSubmit={handleSubmit} className="max-w-5xl pb-24"><fieldset disabled={saving || pending || !!loaded.error}>
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
                      <span title="Залишок на момент додавання. Під час проведення перевіряється актуальний залишок.">{item.qty_on_hand} {item.unit}</span>
                    </td>
                    <td className="px-2 py-2">
                      <input type="number" step={writeoffQuantityStep(item.unit)} min={writeoffQuantityStep(item.unit)}
                        aria-label={"Кількість списання: " + item.product_name}
                        value={item.qty}
                        onChange={(e) => updateQty(i, e.target.value)}
                        className={
                          'w-full text-right border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 ' +
                          ((parseWriteoffQuantity(item.qty) ?? 0) > item.qty_on_hand ? 'border-amber-400 bg-amber-50' : 'border-gray-200')
                        } />
                      {(parseWriteoffQuantity(item.qty) ?? 0) > item.qty_on_hand && <p className="mt-1 text-xs text-amber-700">Більше показаного залишку. При проведенні перевіримо актуальний.</p>}
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
      </fieldset></form>
    </Layout>
  )
}
