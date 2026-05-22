import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Save, Wand2, Plus } from 'lucide-react'
import { productApi } from './productApi'
import { pricingApi } from '@/features/admin/pricingApi'
import { adminApi } from '@/features/admin/adminApi'
import type { ProductFormData } from '@/types/product'
import { kopecksToHryvnia } from '@/types/product'
import { getSpecTemplate } from './productSpecs'
import { ProductPhotoUpload } from './ProductPhotoUpload'
import { Layout } from '@/components/Layout'
import { Button, Input, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

const EMPTY: ProductFormData = {
  sku: '', name: '', barcode: '', brand_id: '', category_id: '',
  unit: 'шт', purchase_price: '', retail_price: '',
  qty_on_hand: '0', reorder_point: '0', notes: '', is_active: true,
  storage_bin: '', is_favorite: false, specs: {},
}

export default function ProductFormPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const isEdit = !!id && id !== 'new'

  const [form, setForm] = useState<ProductFormData>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // Категорії та бренди для "креативних" селектів
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([])
  const [brands, setBrands] = useState<Array<{ id: string; name: string }>>([])
  const [catSearch, setCatSearch] = useState('')
  const [brandSearch, setBrandSearch] = useState('')
  const [catOpen, setCatOpen] = useState(false)
  const [brandOpen, setBrandOpen] = useState(false)

  // Шаблон характеристик для поточної категорії
  const selectedCatName = categories.find((c) => c.id === form.category_id)?.name ?? ''
  const specTemplate = getSpecTemplate(selectedCatName)

  function setSpec(key: string, value: string) {
    setForm((f) => ({ ...f, specs: { ...f.specs, [key]: value } }))
  }

  useEffect(() => {
    Promise.all([
      adminApi.listCategories(),
      adminApi.listBrands(),
    ]).then(([catRes, brandRes]) => {
      setCategories(catRes.data)
      setBrands(brandRes.data)
    }).catch(() => {})
  }, [])

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
        storage_bin: data.storage_bin ?? '',
        is_favorite: data.is_favorite ?? false,
        photo_url: data.photo_url ?? undefined,
        specs: (data.specs as Record<string, string>) ?? {},
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
    if (!form.sku.trim())        { toast.error('Артикул обов\'язковий'); return }
    if (form.name.trim().length < 2) { toast.error('Назва мінімум 2 символи'); return }
    const retailNum = parseFloat(form.retail_price.replace(',', '.'))
    if (!form.retail_price || isNaN(retailNum) || retailNum < 0) {
      toast.error('Вкажіть коректну роздрібну ціну')
      return
    }

    setSaving(true)
    try {
      if (isEdit) {
        await productApi.update(id, form)
        toast.success('Товар оновлено')
      } else {
        const { data } = await productApi.create(form)
        toast.success(`Товар "${data.name}" створено`)
      }
      navigate('/products')
    } catch (err) {
      // api.ts вже показав toast — тут тільки логуємо щоб уникнути дублювання
      // Виняток: якщо це не HTTP-помилка (status відсутній), показуємо сами
      if (!(err as any).status) {
        toast.error(err instanceof Error ? err.message : 'Помилка збереження')
      }
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

            {/* Фото товару */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Фото товару</label>
              <ProductPhotoUpload
                productId={isEdit ? id : undefined}
                currentPhotoUrl={form.photo_url ?? null}
                onPhotoUrl={(url) => setForm((f) => ({ ...f, photo_url: url ?? undefined }))}
              />
            </div>

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

            {/* Категорія та Бренд зі швидким створенням */}
            <div className="grid grid-cols-2 gap-4">
              <div className="relative">
                <label className="block text-sm font-medium text-gray-700 mb-1">Категорія</label>
                <div className="relative">
                  <input value={catSearch || categories.find((c) => c.id === form.category_id)?.name || ''}
                    onChange={(e) => { setCatSearch(e.target.value); setCatOpen(true); setForm((f) => ({ ...f, category_id: '' })) }}
                    onFocus={() => setCatOpen(true)}
                    onBlur={() => setTimeout(() => setCatOpen(false), 200)}
                    placeholder="Пошук або створити..."
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
                  {catOpen && (
                    <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                      {categories
                        .filter((c) => !catSearch || c.name.toLowerCase().includes(catSearch.toLowerCase()))
                        .map((c) => (
                          <button key={c.id} type="button" onClick={() => { setForm((f) => ({ ...f, category_id: c.id })); setCatSearch(''); setCatOpen(false) }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-yellow-50 transition-colors">
                            {c.name}
                          </button>
                        ))}
                      {catSearch.trim() && !categories.some((c) => c.name.toLowerCase() === catSearch.toLowerCase()) && (
                        <button type="button" onClick={async () => {
                            try {
                              const res = await adminApi.createCategory(catSearch.trim())
                              const newCat = (res as any).data ?? res
                              setCategories((prev) => [...prev, newCat])
                              setForm((f) => ({ ...f, category_id: newCat.id }))
                              setCatSearch(''); setCatOpen(false)
                              toast.success('Категорію створено')
                            } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
                          }}
                          className="w-full text-left px-3 py-2 text-sm text-yellow-700 hover:bg-yellow-50 font-medium flex items-center gap-1 transition-colors">
                          <Plus size={14} /> + Створити "{catSearch.trim()}"
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {form.category_id && <p className="text-xs text-green-600 mt-0.5">✓ вибрано</p>}
              </div>
              <div className="relative">
                <label className="block text-sm font-medium text-gray-700 mb-1">Бренд</label>
                <div className="relative">
                  <input value={brandSearch || brands.find((b) => b.id === form.brand_id)?.name || ''}
                    onChange={(e) => { setBrandSearch(e.target.value); setBrandOpen(true); setForm((f) => ({ ...f, brand_id: '' })) }}
                    onFocus={() => setBrandOpen(true)}
                    onBlur={() => setTimeout(() => setBrandOpen(false), 200)}
                    placeholder="Пошук або створити..."
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
                  {brandOpen && (
                    <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                      {brands
                        .filter((b) => !brandSearch || b.name.toLowerCase().includes(brandSearch.toLowerCase()))
                        .map((b) => (
                          <button key={b.id} type="button" onClick={() => { setForm((f) => ({ ...f, brand_id: b.id })); setBrandSearch(''); setBrandOpen(false) }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-yellow-50 transition-colors">
                            {b.name}
                          </button>
                        ))}
                      {brandSearch.trim() && !brands.some((b) => b.name.toLowerCase() === brandSearch.toLowerCase()) && (
                        <button type="button" onClick={async () => {
                            try {
                              const res = await adminApi.createBrand(brandSearch.trim())
                              const newBrand = (res as any).data ?? res
                              setBrands((prev) => [...prev, newBrand])
                              setForm((f) => ({ ...f, brand_id: newBrand.id }))
                              setBrandSearch(''); setBrandOpen(false)
                              toast.success('Бренд створено')
                            } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
                          }}
                          className="w-full text-left px-3 py-2 text-sm text-yellow-700 hover:bg-yellow-50 font-medium flex items-center gap-1 transition-colors">
                          <Plus size={14} /> + Створити "{brandSearch.trim()}"
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {form.brand_id && <p className="text-xs text-green-600 mt-0.5">✓ вибрано</p>}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <Input
                label="Закупівельна ціна (₴)"
                type="number" min="0" step="0.01"
                value={form.purchase_price}
                onChange={(e) => set('purchase_price', e.target.value)}
                placeholder="250.00"
              />
              <div>
                <Input
                  label="Роздрібна ціна (₴) *"
                  type="number" min="0" step="0.01"
                  value={form.retail_price}
                  onChange={(e) => set('retail_price', e.target.value)}
                  placeholder="450.00"
                  required
                />
                {form.purchase_price && form.retail_price
                  && parseFloat(form.purchase_price) > parseFloat(form.retail_price)
                  && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-2 py-1">
                      <span>⚠</span>
                      <span>Ціна закупівлі вища за роздрібну! Прибуток від'ємний.</span>
                    </div>
                  )}
                {form.category_id && form.purchase_price && (
                  <button type="button"
                    className="mt-1 text-xs text-yellow-600 hover:text-yellow-700 flex items-center gap-1"
                    onClick={async () => {
                      const purchase = Math.round(parseFloat(form.purchase_price || '0') * 100)
                      if (!purchase) return
                      try {
                        const res = await pricingApi.autoRetail(purchase, form.category_id)
                        if (res.data.retail_price !== null) {
                          set('retail_price', (res.data.retail_price / 100).toFixed(2))
                          toast.success('Ціну розраховано за наценкою категорії')
                        } else {
                          toast.warning('Для цієї категорії наценка не налаштована')
                        }
                      } catch { toast.error('Помилка розрахунку') }
                    }}>
                    <Wand2 size={12} /> Розрахувати за наценкою
                  </button>
                )}
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

            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Місце зберігання"
                value={form.storage_bin}
                onChange={(e) => set('storage_bin', e.target.value)}
                placeholder="Стелаж A1 / Полиця 3"
                hint="Адреса на складі для пошуку"
              />
              <div></div>
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

            {/* ── Технічні характеристики (залежать від категорії) ── */}
            {specTemplate && (
              <div className="border border-yellow-200 rounded-xl p-4 bg-yellow-50/40 space-y-3">
                <p className="text-sm font-semibold text-gray-800">{specTemplate.label}</p>
                <div className="grid grid-cols-2 gap-3">
                  {specTemplate.fields.map((field) => (
                    <div key={field.key}>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        {field.label}
                        {field.unit && <span className="text-gray-400 ml-1">({field.unit})</span>}
                        {field.required && <span className="text-red-500 ml-1">*</span>}
                      </label>
                      {field.type === 'select' ? (
                        <select
                          value={form.specs?.[field.key] ?? ''}
                          onChange={(e) => setSpec(field.key, e.target.value)}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 bg-white"
                        >
                          <option value="">— Оберіть —</option>
                          {field.options?.map((o) => (
                            <option key={o} value={o}>{o}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={field.type === 'number' ? 'number' : 'text'}
                          value={form.specs?.[field.key] ?? ''}
                          onChange={(e) => setSpec(field.key, e.target.value)}
                          placeholder={field.placeholder}
                          step={field.type === 'number' ? 'any' : undefined}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-3">
              <input type="checkbox" id="is_active"
                checked={form.is_active}
                onChange={(e) => set('is_active', e.target.checked)}
                className="w-4 h-4 accent-yellow-400" />
              <label htmlFor="is_active" className="text-sm text-gray-700">
                Товар активний (відображається в POS)
              </label>
            </div>
            <div className="flex items-center gap-3">
              <input type="checkbox" id="is_favorite"
                checked={form.is_favorite}
                onChange={(e) => set('is_favorite', e.target.checked)}
                className="w-4 h-4 accent-yellow-400" />
              <label htmlFor="is_favorite" className="text-sm text-gray-700">
                ⭐ Швидкий товар (показувати на касі)
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
