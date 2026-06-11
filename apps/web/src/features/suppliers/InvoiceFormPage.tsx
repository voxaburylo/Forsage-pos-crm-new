import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Trash2, Plus } from 'lucide-react'
import { supplierApi } from './supplierApi'
import { productApi } from '@/features/products/productApi'
import { pricingApi } from '@/features/admin/pricingApi'
import type { Product, ProductFormData } from '@/types/product'
import { Layout } from '@/components/Layout'
import { Button, Input, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'

interface LineItem {
  product_id: string
  product_name: string
  qty: number
  purchase_price: number
  retail_price: number      // роздрібна — авторозрахунок по наценці категорії, з ручним правом правки
  category_id: string | null
  total: number
  storage_bin?: string | null
}

export default function InvoiceFormPage() {
  const navigate = useNavigate()
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const isEdit = Boolean(id)
  const preSelectedSupplier = searchParams.get('supplier_id') ?? ''

  const [supplierId, setSupplierId] = useState(preSelectedSupplier)
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [items, setItems] = useState<LineItem[]>([])
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(isEdit)
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  const [productSearch, setProductSearch] = useState('')
  const [productResults, setProductResults] = useState<Product[]>([])
  const [showSearch, setShowSearch] = useState(false)
  // Порівняння закупівельних цін постачальників по доданих товарах
  const [supplierPrices, setSupplierPrices] = useState<Record<string, Array<{ supplier_id: string; supplier_name: string; price: number; date: string }>>>({})
  const [bulkMarkup, setBulkMarkup] = useState<number>(30)

  // Завантажуємо постачальників
  useEffect(() => {
    supplierApi.list({ per_page: 200 }).then((r) => setSuppliers(r.data)).catch(() => {})
  }, [])

  // Якщо редагування — завантажуємо накладну
  useEffect(() => {
    if (id) {
      supplierApi.getInvoice(id).then((res) => {
        const inv = res.data
        setSupplierId(inv.supplier_id ?? '')
        setInvoiceNumber(inv.invoice_number ?? '')
        setNotes(inv.notes ?? '')
        setItems((inv.items ?? []).map((i) => ({
          product_id: i.product_id,
          product_name: i.product?.name ?? 'Товар #' + i.product_id.slice(0, 8),
          qty: i.qty,
          purchase_price: i.purchase_price,
          retail_price: i.product?.retail_price ?? 0,
          category_id: (i.product as any)?.category_id ?? null,
          total: i.total,
          storage_bin: i.product?.storage_bin ?? null,
        })))
      }).catch(() => {
        toast.error('Не вдалось завантажити накладну')
        navigate('/suppliers')
      }).finally(() => setLoading(false))
    }
  }, [id])

  // Пошук товарів
  const searchProducts = useCallback(async (q: string) => {
    if (!q.trim()) { setProductResults([]); return }
    try {
      const res = await productApi.list({ search: q, per_page: 10 })
      setProductResults(res.data)
    } catch { setProductResults([]) }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => searchProducts(productSearch), 300)
    return () => clearTimeout(timer)
  }, [productSearch, searchProducts])

  function addItem(product: Product) {
    if (items.some((i) => i.product_id === product.id)) {
      toast.warning('Товар вже додано')
      return
    }
    setItems((prev) => [...prev, {
      product_id: product.id,
      product_name: product.name,
      qty: 1,
      purchase_price: product.purchase_price,
      retail_price: product.retail_price,
      category_id: product.category_id ?? null,
      total: product.purchase_price,
      storage_bin: product.storage_bin,
    }])
    setProductSearch('')
    setProductResults([])
    setShowSearch(false)

    // Підтягуємо порівняння цін постачальників (закупник бачить «у кого дешевше»)
    productApi.getSupplierPrices(product.id)
      .then((r) => setSupplierPrices((prev) => ({ ...prev, [product.id]: r.data ?? [] })))
      .catch(() => {})
  }

  function updateItem(index: number, field: keyof LineItem, value: string | number) {
    setItems((prev) => {
      const next = [...prev]
      const item = { ...next[index] }
      if (field === 'qty') {
        item.qty = Number(value) || 0
        item.total = Math.round(item.qty * item.purchase_price)
      } else if (field === 'purchase_price') {
        item.purchase_price = Number(value) || 0
        item.total = Math.round(item.qty * item.purchase_price)
      } else if (field === 'retail_price') {
        item.retail_price = Number(value) || 0
      } else {
        (item as Record<string, string | number | null>)[field] = value as string | number | null
      }
      next[index] = item
      return next
    })
  }

  // Сетка цен (ORD P2): авто-розрахунок роздрібної з закупівельної по наценці категорії або сітці
  async function recalcRetail(onlyIndex?: number, forceUseGrid?: boolean) {
    const targets = onlyIndex !== undefined ? [onlyIndex] : items.map((_, i) => i)
    const updates = await Promise.all(targets.map(async (idx) => {
      const it = items[idx]
      if (!it || it.purchase_price <= 0) return null
      try {
        const categoryId = forceUseGrid ? undefined : (it.category_id ?? undefined)
        const r = await pricingApi.autoRetail(it.purchase_price, categoryId)
        return r.data?.retail_price != null ? { idx, retail: r.data.retail_price } : null
      } catch { return null }
    }))
    const map = new Map(updates.filter(Boolean).map((u) => [u!.idx, u!.retail]))
    if (map.size === 0) {
      if (onlyIndex === undefined) {
        toast.warning(forceUseGrid
          ? 'Сітка націнок не налаштована або не повернула результат'
          : 'Наценки категорій не задані — задайте їх у «Ціноутворення»'
        )
      }
      return
    }
    setItems((prev) => prev.map((it, i) => map.has(i) ? { ...it, retail_price: map.get(i)! } : it))
  }

  // Застосування фіксованої націнки на всю накладну
  function applyBulkMarkup() {
    if (bulkMarkup <= 0) {
      toast.warning('Введіть відсоток націнки більше 0')
      return
    }
    setItems((prev) =>
      prev.map((it) => {
        if (it.purchase_price <= 0) return it
        const calculatedRetail = Math.round(it.purchase_price * (1 + bulkMarkup / 100))
        return { ...it, retail_price: calculatedRetail }
      })
    )
    toast.success(`Встановлено націнку ${bulkMarkup}% для всіх товарів накладної`)
  }

  function removeItem(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  const total = items.reduce((sum, i) => sum + i.total, 0)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (items.length === 0) { toast.error('Додайте хоча б один товар'); return }
    if (!supplierId) { toast.error('Оберіть постачальника'); return }

    setSaving(true)
    try {
      const body = {
        supplier_id: supplierId,
        invoice_number: invoiceNumber.trim() || null,
        notes: notes.trim() || null,
        items: items.map((i) => ({
          product_id: i.product_id,
          qty: i.qty,
          purchase_price: i.purchase_price,
          total: i.total,
        })),
      }
      if (isEdit) {
        await supplierApi.updateInvoice(id!, { invoice_number: body.invoice_number, notes: body.notes })
        toast.success('Накладну оновлено')
      } else {
        await supplierApi.createInvoice(body)

        // Комірки та роздрібні ціни (сітка цін на приході) — ПІСЛЯ успішного
        // створення накладної, щоб невдале збереження не міняло товари
        const results = await Promise.allSettled(
          items.map(async (item) => {
            const patch: Partial<ProductFormData> = {
              storage_bin: item.storage_bin ?? '',
            }
            if (item.retail_price > 0) patch.retail_price = (item.retail_price / 100).toFixed(2)
            await productApi.update(item.product_id, patch)
          })
        )
        if (results.some((r) => r.status === 'rejected')) {
          toast.warning('Накладну створено, але не всі комірки/ціни товарів оновились')
        } else {
          toast.success('Накладну створено')
        }
      }
      navigate(`/suppliers/invoices`)
    } catch {
      toast.error('Помилка збереження накладної')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Layout title="Завантаження..."><div className="text-gray-400 text-sm">Завантаження...</div></Layout>

  return (
    <Layout
      title={isEdit ? 'Редагувати накладну' : 'Нова приходна накладна'}
      onBack={() => navigate('/suppliers/invoices')}
    >
      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <Card>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Постачальник *</label>
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
                  disabled={isEdit}>
                  <option value="">— Оберіть —</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <Input label="№ накладної" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="Номер від постачальника" />
            </div>
          </Card>
          <Card>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Нотатки</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
                rows={4} placeholder="Коментар до накладної..." />
            </div>
          </Card>
        </div>

        {/* Позиції */}
        <Card padding="none" className="mb-6">
          <div className="px-4 py-3 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <span className="text-sm font-semibold text-gray-800 shrink-0">Позиції ({items.length})</span>
            {!isEdit && (
              <div className="flex flex-wrap items-center gap-2">
                {items.length > 0 && (
                  <div className="flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded-xl px-2 py-1 flex-wrap">
                    <span className="text-[10px] font-bold text-gray-400 uppercase mr-1">Націнка:</span>
                    <button type="button" onClick={() => recalcRetail(undefined, true)}
                      className="px-2 py-1 bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-700 text-xs font-semibold rounded-lg transition-colors border border-yellow-500/20"
                      title="Розрахувати роздрібні ціни за сіткою націнок (від-до з налаштувань)">
                      📈 За сіткою
                    </button>
                    <button type="button" onClick={() => recalcRetail()}
                      className="px-2 py-1 bg-blue-500/10 hover:bg-blue-500/20 text-blue-700 text-xs font-semibold rounded-lg transition-colors border border-blue-500/20"
                      title="Розрахувати роздрібні ціни за націнками категорій">
                      🗂️ За категоріями
                    </button>
                    <div className="w-px h-4 bg-gray-300 mx-1" />
                    <input
                      type="number"
                      min="0"
                      value={bulkMarkup || ''}
                      onChange={(e) => setBulkMarkup(Number(e.target.value) || 0)}
                      className="w-12 border border-gray-200 rounded px-1.5 py-0.5 text-xs text-right focus:outline-none focus:ring-1 focus:ring-yellow-400 bg-white"
                      title="Ручна націнка на всю накладну в %"
                      placeholder="%"
                    />
                    <button type="button" onClick={applyBulkMarkup}
                      className="px-2 py-1 bg-gray-700 hover:bg-gray-650 text-white text-xs font-medium rounded-lg transition-colors"
                      title="Націнити всі позиції на вказаний відсоток">
                      Встановити %
                    </button>
                  </div>
                )}
                <Button type="button" size="sm" variant="outline" icon={<Plus size={14} />}
                  onClick={() => setShowSearch(!showSearch)}>
                  Додати товар
                </Button>
              </div>
            )}
            {isEdit && (
              <span className="text-xs text-gray-400 italic">Позиції не змінюються при редагуванні</span>
            )}
          </div>

          {showSearch && !isEdit && (
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
              <Input value={productSearch} onChange={(e) => setProductSearch(e.target.value)} placeholder="Пошук товарів за назвою..." className="max-w-md" autoFocus />
              {productResults.length > 0 && (
                <div className="mt-2 max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-sm">
                  {productResults.map((p) => (
                    <button key={p.id} type="button" onClick={() => addItem(p)}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-yellow-50 flex items-center justify-between">
                      <span>{p.name}</span>
                      <span className="text-gray-400 text-xs">{p.sku} — {formatMoney(p.retail_price)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 uppercase border-b border-gray-100">
                <th className="text-left px-4 py-2">Товар</th>
                <th className="text-left px-2 py-2 w-28">Комірка</th>
                <th className="text-right px-2 py-2 w-16">К-сть</th>
                <th className="text-right px-2 py-2 w-24">Закупка, грн</th>
                <th className="text-right px-2 py-2 w-24 text-right">Націнка</th>
                <th className="text-right px-2 py-2 w-28">Розн. ціна, грн</th>
                <th className="text-right px-4 py-2 w-24">Сума</th>
                <th className="w-10 px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => {
                const prices = supplierPrices[item.product_id] ?? []
                const best = prices[0]
                const cheaperElsewhere = best && supplierId && best.supplier_id !== supplierId && best.price < item.purchase_price
                return (
                <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                  <td className="px-4 py-2 font-medium">
                    {item.product_name}
                    {best && (
                      <div className={`text-[11px] mt-0.5 font-normal ${cheaperElsewhere ? 'text-orange-600 font-semibold' : 'text-gray-400'}`}
                        title={prices.slice(0, 5).map((p) => `${p.supplier_name}: ${(p.price / 100).toFixed(2)} грн`).join('\n')}>
                        🏷 найдешевше: {(best.price / 100).toFixed(2)} грн — {best.supplier_name}
                        {cheaperElsewhere && ` (дешевше за поточну на ${((item.purchase_price - best.price) / 100).toFixed(2)} грн)`}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <input type="text" value={item.storage_bin ?? ''}
                      onChange={(e) => updateItem(i, 'storage_bin', e.target.value)}
                      disabled={isEdit}
                      placeholder="Немає"
                      className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400" />
                  </td>
                  <td className="px-2 py-2">
                    <input type="number" step="0.001" min="0.001" value={item.qty}
                      onChange={(e) => updateItem(i, 'qty', e.target.value)}
                      disabled={isEdit}
                      className="w-full text-right border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400" />
                  </td>
                  <td className="px-2 py-2">
                    <input type="number" step="0.01" min="0"
                      value={(item.purchase_price / 100).toFixed(2)}
                      onChange={(e) => updateItem(i, 'purchase_price', String(Math.round(parseFloat(e.target.value || '0') * 100)))}
                      onBlur={() => { if (!isEdit) recalcRetail(i) }}
                      disabled={isEdit}
                      className="w-full text-right border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400" />
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <input
                        type="number"
                        min="-100"
                        value={item.purchase_price > 0 ? Math.round((item.retail_price / item.purchase_price - 1) * 100) : 0}
                        onChange={(e) => {
                          const pct = Number(e.target.value) || 0
                          const retail = Math.round(item.purchase_price * (1 + pct / 100))
                          updateItem(i, 'retail_price', retail)
                        }}
                        disabled={isEdit || item.purchase_price <= 0}
                        placeholder="0"
                        className="w-16 text-right border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400 bg-white"
                      />
                      <span className="text-gray-400 text-xs font-semibold">%</span>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <input type="number" step="0.01" min="0"
                      value={(item.retail_price / 100).toFixed(2)}
                      onChange={(e) => updateItem(i, 'retail_price', String(Math.round(parseFloat(e.target.value || '0') * 100)))}
                      disabled={isEdit}
                      className="w-full text-right border border-gray-200 rounded px-2 py-1 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400 bg-white" />
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{formatMoney(item.total)}</td>
                  <td className="px-2 py-2">
                    {!isEdit && (
                      <button type="button" onClick={() => removeItem(i)}
                        className="text-red-300 hover:text-red-500 p-1"><Trash2 size={14} /></button>
                    )}
                  </td>
                </tr>
                )
              })}
              {items.length === 0 && (
                <tr><td colSpan={8} className="text-center text-gray-400 text-sm py-6">Позицій немає. Додайте товари.</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr className="font-semibold bg-gray-50">
                <td colSpan={6} className="px-4 py-2 text-right">Всього:</td>
                <td className="px-4 py-2 text-right font-mono">{formatMoney(total)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </Card>

        <div className="flex gap-3">
          <Button type="submit" disabled={saving}>
            {saving ? 'Збереження...' : isEdit ? 'Оновити' : 'Створити'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate('/suppliers/invoices')}>Скасувати</Button>
        </div>
      </form>
    </Layout>
  )
}