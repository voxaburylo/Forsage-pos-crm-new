import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Save } from 'lucide-react'
import { productApi } from './productApi'
import type { ProductFormData } from '@/types/product'
import { kopecksToHryvnia } from '@/types/product'
import { Layout } from '@/components/Layout'
import { Button, Input, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

const EMPTY: ProductFormData = {
  sku: '', name: '', barcode: '', brand_id: '', category_id: '',
  unit: 'шт', purchase_price: '', retail_price: '',
  qty_on_hand: '0', reorder_point: '0', notes: '', is_active: true,
}

export default function ProductFormPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const isEdit = !!id && id !== 'new'

  const [form, setForm] = useState<ProductFormData>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!isEdit) return
    setLoading(true)
    productApi.get(id).then(({ data }) => {
      setForm({
        sku: data.sku,
        name: data.name,
        barcode: data.barcode ?? '',
        brand_id: data.brand_id ?? '',
        category_id: data.category_id ?? '',
        unit: data.unit as ProductFormData['unit'],
        purchase_price: kopecksToHryvnia(data.purchase_price),
        retail_price: kopecksToHryvnia(data.retail_price),
        qty_on_hand: String(data.qty_on_hand),
        reorder_point: String(data.reorder_point),
        notes: data.notes ?? '',
        is_active: data.is_active,
      })
    }).catch(() => {
      toast.error('Товар не знайдено')
      navigate('/products')
    }).finally(() => setLoading(false))
  }, [id, isEdit, navigate])

  function set(field: keyof ProductFormData, value: string | boolean) {
    setForm((f) => ({ ...f, [field]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.sku.trim()) { toast.error('Артикул обов\'язковий'); return }
    if (!form.name.trim()) { toast.error('Назва обов\'язкова'); return }
    if (!form.retail_price) { toast.error('Вкажіть роздрібну ціну'); return }

    setSaving(true)
    try {
      if (isEdit) {
        await productApi.update(id, form)
        toast.success('Товар оновлено')
      } else {
        await productApi.create(form)
        toast.success('Товар створено')
      }
      navigate('/products')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка збереження')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Layout><div className="flex items-center justify-center h-64 text-gray-400 text-sm">Завантаження...</div></Layout>

  return (
    <Layout title={isEdit ? 'Редагувати товар' : 'Новий товар'}>
      <div className="max-w-2xl">
        <form onSubmit={handleSubmit}>
          <Card className="space-y-5">

            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Артикул (SKU) *"
                value={form.sku}
                onChange={(e) => set('sku', e.target.value)}
                placeholder="W712, 04465-33471..."
                required
              />
              <Input
                label="Штрихкод"
                value={form.barcode}
                onChange={(e) => set('barcode', e.target.value)}
                placeholder="4006633364515"
              />
            </div>

            <Input
              label="Назва товару *"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Фільтр оливний Mann W712"
              required
            />

            <div className="grid grid-cols-3 gap-4">
              <Input
                label="Закупівельна ціна (₴)"
                type="number" min="0" step="0.01"
                value={form.purchase_price}
                onChange={(e) => set('purchase_price', e.target.value)}
                placeholder="250.00"
              />
              <Input
                label="Роздрібна ціна (₴) *"
                type="number" min="0" step="0.01"
                value={form.retail_price}
                onChange={(e) => set('retail_price', e.target.value)}
                placeholder="450.00"
                required
              />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Одиниця</label>
                <select
                  value={form.unit}
                  onChange={(e) => set('unit', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  {['шт', 'л', 'кг', 'м', 'компл'].map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Поточний залишок"
                type="number" min="0" step="0.001"
                value={form.qty_on_hand}
                onChange={(e) => set('qty_on_hand', e.target.value)}
              />
              <Input
                label="Мінімальний залишок"
                type="number" min="0" step="0.001"
                value={form.reorder_point}
                onChange={(e) => set('reorder_point', e.target.value)}
                hint="При залишку ≤ цього значення — попередження"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Примітки</label>
              <textarea
                value={form.notes}
                onChange={(e) => set('notes', e.target.value)}
                rows={3}
                placeholder="Додаткова інформація..."
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
              />
            </div>

            <div className="flex items-center gap-3">
              <input
                type="checkbox" id="is_active"
                checked={form.is_active}
                onChange={(e) => set('is_active', e.target.checked)}
                className="w-4 h-4 accent-yellow-400"
              />
              <label htmlFor="is_active" className="text-sm text-gray-700">
                Товар активний (відображається в POS)
              </label>
            </div>

            <div className="flex gap-3 pt-2">
              <Button type="submit" loading={saving} icon={<Save size={16} />}>
                {isEdit ? 'Зберегти зміни' : 'Створити товар'}
              </Button>
              <Button type="button" variant="secondary" onClick={() => navigate('/products')}>
                Скасувати
              </Button>
            </div>
          </Card>
        </form>
      </div>
    </Layout>
  )
}
