import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Trash2, Plus } from 'lucide-react'
import { supplierApi } from './supplierApi'
import { productApi } from '@/features/products/productApi'

import type { Product } from '@/types/product'
import { Layout } from '@/components/Layout'
import { Button, Input, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'

interface LineItem {
  product_id: string
  product_name: string
  qty: number
  purchase_price: number
  total: number
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
          total: i.total,
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
      total: product.purchase_price,
    }])
    setProductSearch('')
    setProductResults([])
    setShowSearch(false)
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
      } else {
        (item as Record<string, string | number>)[field] = value as string | number
      }
      next[index] = item
      return next
    })
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
        toast.success('Накладну створено')
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
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-800">Позиції ({items.length})</span>
            {!isEdit && (
              <Button type="button" size="sm" variant="outline" icon={<Plus size={14} />}
                onClick={() => setShowSearch(!showSearch)}>
                Додати товар
              </Button>
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
                <th className="text-right px-2 py-2 w-20">Кількість</th>
                <th className="text-right px-2 py-2 w-24">Ціна, грн</th>
                <th className="text-right px-4 py-2 w-24">Сума</th>
                <th className="w-10 px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                  <td className="px-4 py-2 font-medium">{item.product_name}</td>
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
                      disabled={isEdit}
                      className="w-full text-right border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:bg-gray-50 disabled:text-gray-400" />
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{formatMoney(item.total)}</td>
                  <td className="px-2 py-2">
                    {!isEdit && (
                      <button type="button" onClick={() => removeItem(i)}
                        className="text-red-300 hover:text-red-500 p-1"><Trash2 size={14} /></button>
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={5} className="text-center text-gray-400 text-sm py-6">Позицій немає. Додайте товари.</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr className="font-semibold bg-gray-50">
                <td colSpan={3} className="px-4 py-2 text-right">Всього:</td>
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