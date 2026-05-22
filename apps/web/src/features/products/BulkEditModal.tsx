import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { adminApi } from '@/features/admin/adminApi'
import { Modal, Button } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

interface Props {
  open: boolean
  productIds: string[]
  onClose: () => void
  onUpdated: () => void
}

interface Category { id: string; name: string }

export function BulkEditModal({ open, productIds, onClose, onUpdated }: Props) {
  const [retailPrice, setRetailPrice] = useState('')
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
    if (retailPrice.trim())  updates.retail_price  = Math.round(parseFloat(retailPrice) * 100)
    if (purchasePrice.trim()) updates.purchase_price = Math.round(parseFloat(purchasePrice) * 100)
    if (categoryId)          updates.category_id   = categoryId
    if (isActive === 'true') updates.is_active = true
    if (isActive === 'false') updates.is_active = false

    if (Object.keys(updates).length === 0) { toast.error('Оберіть хоча б одне поле для зміни'); return }

    setSaving(true)
    try {
      await api.post('/api/v1/products/bulk-update', { product_ids: productIds, updates })
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
    setRetailPrice(''); setPurchasePrice(''); setCategoryId(''); setIsActive('')
    onClose()
  }

  return (
    <Modal open={open} onClose={handleClose} title={`Масове оновлення (${productIds.length} товарів)`} size="sm">
      <div className="space-y-4">

        <p className="text-xs text-gray-400">Залиште поля порожніми, щоб не змінювати їх.</p>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Роздрібна ціна (₴)</label>
          <input type="number" min="0" step="0.01" value={retailPrice}
            onChange={(e) => setRetailPrice(e.target.value)}
            placeholder="Наприклад: 299.90"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400" />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Собівартість (₴)</label>
          <input type="number" min="0" step="0.01" value={purchasePrice}
            onChange={(e) => setPurchasePrice(e.target.value)}
            placeholder="Наприклад: 150.00"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400" />
        </div>

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

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Активність</label>
          <select value={isActive} onChange={(e) => setIsActive(e.target.value as typeof isActive)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 bg-white">
            <option value="">— Не змінювати —</option>
            <option value="true">✅ Активувати</option>
            <option value="false">🚫 Деактивувати</option>
          </select>
        </div>

        <div className="flex gap-3 pt-1">
          <Button onClick={handleSave} loading={saving} className="flex-1">
            Оновити {productIds.length} товарів
          </Button>
          <Button variant="secondary" onClick={handleClose}>Скасувати</Button>
        </div>
      </div>
    </Modal>
  )
}
