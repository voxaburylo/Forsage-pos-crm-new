import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { adminApi } from '@/features/admin/adminApi'
import { productApi } from './productApi'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import type { ProductFormData } from '@/types/product'
import { Modal, Button } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

interface Props {
  open: boolean
  productIds: string[]
  onClose: () => void
  onUpdated: () => void
}

interface Category { id: string; name: string }

type RetailMode = 'none' | 'fixed' | 'percent' | 'amount' | 'markup'
type PurchaseMode = 'none' | 'fixed' | 'percent' | 'amount'

function adjustedPrice(current: number, action: { type: string; value: number } | undefined, purchasePrice: number): number {
  if (!action) return current
  if (action.type === 'percent') return Math.max(0, Math.round(current * (1 + action.value / 100)))
  if (action.type === 'amount') return Math.max(0, Math.round(current + action.value))
  if (action.type === 'markup') return Math.max(0, Math.round(purchasePrice * (1 + action.value / 100)))
  return current
}

async function updateLocalProducts(productIds: string[], updates: Record<string, any>): Promise<void> {
  const chunkSize = 20
  for (let offset = 0; offset < productIds.length; offset += chunkSize) {
    await Promise.all(productIds.slice(offset, offset + chunkSize).map(async (id) => {
      const current = (await productApi.get(id)).data
      const purchasePrice = updates.purchase_price !== undefined
        ? Number(updates.purchase_price)
        : adjustedPrice(
            Number(current.purchase_price),
            updates.purchase_price_action,
            Number(current.purchase_price),
          )
      const retailPrice = updates.retail_price !== undefined
        ? Number(updates.retail_price)
        : adjustedPrice(Number(current.retail_price), updates.retail_price_action, purchasePrice)
      const form: Partial<ProductFormData> = {
        purchase_price: (purchasePrice / 100).toFixed(2),
        retail_price: (retailPrice / 100).toFixed(2),
      }
      if (updates.category_id !== undefined) form.category_id = updates.category_id
      if (updates.is_active !== undefined) form.is_active = updates.is_active
      await productApi.update(id, form)
    }))
  }
}

export function BulkEditModal({ open, productIds, onClose, onUpdated }: Props) {
  const [retailMode, setRetailMode] = useState<RetailMode>('none')
  const [retailPrice, setRetailPrice] = useState('')

  const [purchaseMode, setPurchaseMode] = useState<PurchaseMode>('none')
  const [purchasePrice, setPurchasePrice] = useState('')

  const [categoryId, setCategoryId]   = useState('')
  const [isActive, setIsActive]       = useState<'' | 'true' | 'false'>('')
  const [saving, setSaving]           = useState(false)
  const [categories, setCategories]   = useState<Category[]>([])

  useEffect(() => {
    if (open) {
      adminApi.listCategories()
        .then((r) => setCategories(r.data as Category[]))
        .catch(() => {})
    }
  }, [open])

  async function handleSave() {
    const updates: Record<string, unknown> = {}

    // Retail price adjustment
    if (retailMode !== 'none') {
      if (!retailPrice.trim()) {
        toast.error('Введіть значення для зміни роздрібної ціни')
        return
      }
      const val = parseFloat(retailPrice)
      if (isNaN(val)) {
        toast.error('Введіть коректне число для роздрібної ціни')
        return
      }
      if (retailMode === 'fixed') {
        updates.retail_price = Math.round(val * 100)
      } else {
        updates.retail_price_action = {
          type: retailMode,
          value: retailMode === 'amount' ? Math.round(val * 100) : val
        }
      }
    }

    // Purchase price adjustment
    if (purchaseMode !== 'none') {
      if (!purchasePrice.trim()) {
        toast.error('Введіть значення для зміни собівартості')
        return
      }
      const val = parseFloat(purchasePrice)
      if (isNaN(val)) {
        toast.error('Введіть коректне число для собівартості')
        return
      }
      if (purchaseMode === 'fixed') {
        updates.purchase_price = Math.round(val * 100)
      } else {
        updates.purchase_price_action = {
          type: purchaseMode,
          value: purchaseMode === 'amount' ? Math.round(val * 100) : val
        }
      }
    }

    if (categoryId)          updates.category_id   = categoryId
    if (isActive === 'true') updates.is_active = true
    if (isActive === 'false') updates.is_active = false

    if (Object.keys(updates).length === 0) {
      toast.error('Оберіть хоча б одне поле для зміни')
      return
    }

    setSaving(true)
    try {
      if (isDesktopRuntime()) await updateLocalProducts(productIds, updates)
      else await api.post('/api/v1/products/bulk-update', { product_ids: productIds, updates })
      toast.success(`Оновлено ${productIds.length} товарів`)
      onUpdated()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка')
    } finally {
      setSaving(false)
    }
  }

  function handleClose() {
    setRetailMode('none')
    setRetailPrice('')
    setPurchaseMode('none')
    setPurchasePrice('')
    setCategoryId('')
    setIsActive('')
    onClose()
  }

  return (
    <Modal open={open} onClose={handleClose} title={`Масове оновлення (${productIds.length} товарів)`} size="sm">
      <div className="space-y-4">
        <p className="text-xs text-gray-400">Виберіть параметри, які бажаєте змінити.</p>

        {/* Роздрібна ціна */}
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-700">Роздрібна ціна</label>
          <select value={retailMode} onChange={(e) => { setRetailMode(e.target.value as RetailMode); setRetailPrice('') }}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 bg-white">
            <option value="none">— Не змінювати —</option>
            <option value="fixed">Встановити фіксовану ціну (₴)</option>
            <option value="percent">Змінити на відсоток (%) наприклад +5 або -10</option>
            <option value="amount">Змінити на фіксовану суму (₴) наприклад +50 або -20</option>
            <option value="markup">Націнка від собівартості (%) наприклад +30</option>
          </select>
          {retailMode !== 'none' && (
            <input type="number" step="any" value={retailPrice}
              onChange={(e) => setRetailPrice(e.target.value)}
              placeholder={
                retailMode === 'fixed' ? 'Наприклад: 299.90' :
                retailMode === 'percent' ? 'Наприклад: 10 або -5' :
                retailMode === 'amount' ? 'Наприклад: 50 або -150' : 'Наприклад: 30'
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400" />
          )}
        </div>

        {/* Собівартість */}
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-700">Собівартість</label>
          <select value={purchaseMode} onChange={(e) => { setPurchaseMode(e.target.value as PurchaseMode); setPurchasePrice('') }}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 bg-white">
            <option value="none">— Не змінювати —</option>
            <option value="fixed">Встановити фіксовану собівартість (₴)</option>
            <option value="percent">Змінити на відсоток (%) наприклад +5 або -10</option>
            <option value="amount">Змінити на фіксовану суму (₴) наприклад +50 або -20</option>
          </select>
          {purchaseMode !== 'none' && (
            <input type="number" step="any" value={purchasePrice}
              onChange={(e) => setPurchasePrice(e.target.value)}
              placeholder={
                purchaseMode === 'fixed' ? 'Наприклад: 150.00' :
                purchaseMode === 'percent' ? 'Наприклад: 5 або -10' : 'Наприклад: 20 або -50'
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400" />
          )}
        </div>

        {/* Категорія */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Категорія</label>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 bg-white">
            <option value="">— Не змінювати —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        {/* Активність */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Активність</label>
          <select value={isActive} onChange={(e) => setIsActive(e.target.value as typeof isActive)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 bg-white">
            <option value="">— Не змінювати —</option>
            <option value="true">✅ Активувати</option>
            <option value="false">🚫 Деактивувати</option>
          </select>
        </div>

        <div className="flex gap-3 pt-2">
          <Button onClick={handleSave} loading={saving} className="flex-1">
            Оновити {productIds.length} товарів
          </Button>
          <Button variant="secondary" onClick={handleClose}>Скасувати</Button>
        </div>
      </div>
    </Modal>
  )
}
