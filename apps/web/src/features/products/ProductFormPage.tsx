import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Package, Save, ArrowLeft } from 'lucide-react'
import { productApi } from './productApi'
import type { ProductFormData } from '@/types/product'
import { kopecksToHryvnia } from '@/types/product'

const EMPTY_FORM: ProductFormData = {
  sku: '',
  name: '',
  barcode: '',
  brand_id: '',
  category_id: '',
  unit: 'шт',
  purchase_price: '',
  retail_price: '',
  qty_on_hand: '0',
  reorder_point: '0',
  notes: '',
  is_active: true,
}

export default function ProductFormPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const isEdit = !!id && id !== 'new'

  const [form, setForm] = useState<ProductFormData>(EMPTY_FORM)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

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
    }).catch(() => setError('Товар не знайдено')).finally(() => setLoading(false))
  }, [id, isEdit])

  function set(field: keyof ProductFormData, value: string | boolean) {
    setForm((f) => ({ ...f, [field]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!form.sku.trim()) { setError('Артикул обов\'язковий'); return }
    if (!form.name.trim()) { setError('Назва обов\'язкова'); return }
    if (!form.retail_price) { setError('Вкажіть роздрібну ціну'); return }

    setSaving(true)
    try {
      if (isEdit) {
        await productApi.update(id, form)
      } else {
        await productApi.create(form)
      }
      navigate('/products')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Помилка збереження')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center">
      <p className="text-gray-400 text-sm">Завантаження...</p>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-3">
        <button onClick={() => navigate('/products')} className="text-gray-400 hover:text-gray-600">
          <ArrowLeft size={20} />
        </button>
        <Package size={20} className="text-gray-600" />
        <h1 className="font-bold text-gray-900">
          {isEdit ? 'Редагувати товар' : 'Новий товар'}
        </h1>
      </header>

      <main className="max-w-2xl mx-auto p-6">
        <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-5">

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>
          )}

          {/* Основные данные */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Артикул (SKU) *</label>
              <input
                value={form.sku}
                onChange={(e) => set('sku', e.target.value)}
                placeholder="W712, 04465-33471..."
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Штрихкод</label>
              <input
                value={form.barcode}
                onChange={(e) => set('barcode', e.target.value)}
                placeholder="4006633364515"
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Назва товару *</label>
            <input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Фільтр оливний Mann W712"
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              required
            />
          </div>

          {/* Ціни */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Закупівельна ціна (₴)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.purchase_price}
                onChange={(e) => set('purchase_price', e.target.value)}
                placeholder="250.00"
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Роздрібна ціна (₴) *</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.retail_price}
                onChange={(e) => set('retail_price', e.target.value)}
                placeholder="450.00"
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                required
              />
            </div>
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

          {/* Залишки */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Поточний залишок</label>
              <input
                type="number"
                min="0"
                step="0.001"
                value={form.qty_on_hand}
                onChange={(e) => set('qty_on_hand', e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Мінімальний залишок</label>
              <input
                type="number"
                min="0"
                step="0.001"
                value={form.reorder_point}
                onChange={(e) => set('reorder_point', e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <p className="text-xs text-gray-400 mt-1">При залишку ≤ цього значення — попередження</p>
            </div>
          </div>

          {/* Примечания */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Примітки</label>
            <textarea
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={3}
              placeholder="Додаткова інформація про товар..."
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
            />
          </div>

          {/* Активность */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="is_active"
              checked={form.is_active}
              onChange={(e) => set('is_active', e.target.checked)}
              className="w-4 h-4 accent-yellow-400"
            />
            <label htmlFor="is_active" className="text-sm text-gray-700">Товар активний (відображається в POS)</label>
          </div>

          {/* Кнопки */}
          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 bg-accent hover:bg-accent-dark text-black font-semibold px-6 py-2.5 rounded-lg text-sm transition-colors disabled:opacity-50"
            >
              <Save size={16} />
              {saving ? 'Збереження...' : isEdit ? 'Зберегти зміни' : 'Створити товар'}
            </button>
            <button
              type="button"
              onClick={() => navigate('/products')}
              className="px-6 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:border-gray-300 transition-colors"
            >
              Скасувати
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}
