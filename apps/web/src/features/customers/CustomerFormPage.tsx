import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Car, Save } from 'lucide-react'
import { customerApi } from './customerApi'
import { pricingApi } from '@/features/admin/pricingApi'
import type { PriceTier } from '@/features/admin/pricingApi'
import { TAGS } from '@/types/customer'
import { Layout } from '@/components/Layout'
import { Button, Input, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

interface FormData {
  phone:         string
  full_name:     string
  email:         string
  notes:         string
  tags:          string[]
  price_tier_id: string
  card_barcode:  string
  discount_pct:  string
  client_status: string
  car_brand:     string
  car_model:     string
  car_year:      string
  car_vin:       string
}

const EMPTY: FormData = {
  phone: '', full_name: '', email: '', notes: '', tags: [], price_tier_id: '',
  card_barcode: '', discount_pct: '0', client_status: 'client',
  car_brand: '', car_model: '', car_year: '', car_vin: '',
}

export default function CustomerFormPage() {
  const navigate = useNavigate()
  const { id }   = useParams<{ id: string }>()
  const isEdit   = !!id && id !== 'new'

  const [form, setForm]     = useState<FormData>(EMPTY)
  const [tiers, setTiers]   = useState<PriceTier[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving]   = useState(false)

  useEffect(() => {
    pricingApi.listTiers().then((res) => setTiers(res.data)).catch(() => {})
  }, [])

  useEffect(() => {
    if (!isEdit) return
    setLoading(true)
    customerApi.get(id).then(({ data }) => {
      const d = data as typeof data & { price_tier_id?: string | null }
      setForm({
        phone:         d.phone,
        full_name:     d.full_name ?? '',
        email:         d.email ?? '',
        notes:         d.notes ?? '',
        tags:          d.tags,
        price_tier_id: d.price_tier_id ?? '',
        card_barcode:  (d as any).card_barcode ?? '',
        discount_pct:  String((d as any).discount_pct ?? 0),
        client_status: (d as any).client_status ?? 'client',
        car_brand:     '',
        car_model:     '',
        car_year:      '',
        car_vin:       '',
      })
    }).catch(() => {
      toast.error('Клієнта не знайдено')
      navigate('/customers')
    }).finally(() => setLoading(false))
  }, [id, isEdit, navigate])

  function set(field: keyof FormData, value: string) {
    setForm((f) => ({ ...f, [field]: value }))
  }

  function toggleTag(tag: string) {
    setForm((f) => ({
      ...f,
      tags: f.tags.includes(tag) ? f.tags.filter((t) => t !== tag) : [...f.tags, tag],
    }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.phone.trim()) { toast.error("Телефон обов'язковий"); return }

    setSaving(true)
    try {
      const body = {
        phone:         form.phone || undefined,
        full_name:     form.full_name || undefined,
        email:         form.email || undefined,
        notes:         form.notes || undefined,
        tags:          form.tags,
        price_tier_id: (form.price_tier_id || null) as string | null | undefined,
        discount_pct:  Number(form.discount_pct) || 0,
        client_status: form.client_status,
        card_barcode:  form.card_barcode.trim() || null,
        ...(!isEdit && (form.car_vin.trim() || form.car_brand.trim() || form.car_model.trim()) ? {
          vehicle: {
            brand: form.car_brand.trim() || 'Авто',
            model: form.car_model.trim() || '—',
            year: form.car_year ? Number(form.car_year) : null,
            vin: form.car_vin.trim().toUpperCase() || null,
          },
        } : {}),
      }
      if (isEdit) {
        await customerApi.update(id, body)
        toast.success('Клієнта оновлено')
        navigate('/customers')
      } else {
        const result = await customerApi.create(body as Parameters<typeof customerApi.create>[0])
        if (result.meta?.reused) {
          toast.success(result.meta.vehicle_added
            ? 'Клієнт уже існував — нове авто додано в його картку'
            : 'Клієнт уже існує — відкрито його картку')
        } else {
          toast.success(result.meta?.vehicle_added ? 'Клієнта й автомобіль створено' : 'Клієнта створено')
        }
        navigate(`/customers/${result.data.id}`)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка збереження')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Layout><div className="flex items-center justify-center h-64 text-gray-400 text-sm">Завантаження...</div></Layout>

  return (
    <Layout title={isEdit ? 'Редагувати клієнта' : 'Новий клієнт'}>
      <div className="max-w-lg">
        <form onSubmit={handleSubmit}>
          <Card className="space-y-5">

            <Input label="Телефон *" type="tel"
              value={form.phone} onChange={(e) => set('phone', e.target.value)}
              placeholder="+380671234567" required autoFocus={!isEdit} />

            <Input label="Ім'я"
              value={form.full_name} onChange={(e) => set('full_name', e.target.value)}
              placeholder="Іваненко Іван Іванович" />

            <Input label="Email" type="email"
              value={form.email} onChange={(e) => set('email', e.target.value)}
              placeholder="ivan@example.com" />

            {!isEdit && (
              <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <Car size={18} className="text-blue-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-gray-900">Автомобіль клієнта</p>
                    <p className="text-xs text-gray-500">
                      Якщо цей телефон уже є в базі, новий VIN додасться до існуючої картки клієнта.
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input label="Марка"
                    value={form.car_brand} onChange={(e) => set('car_brand', e.target.value)}
                    placeholder="Chevrolet" />
                  <Input label="Модель"
                    value={form.car_model} onChange={(e) => set('car_model', e.target.value)}
                    placeholder="Lanos" />
                  <Input label="Рік" type="number"
                    value={form.car_year} onChange={(e) => set('car_year', e.target.value)}
                    placeholder="2008" min="1900" max="2100" />
                  <Input label="VIN"
                    value={form.car_vin} onChange={(e) => set('car_vin', e.target.value.toUpperCase())}
                    placeholder="17 символів" maxLength={17} />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Персональна знижка (%)</label>
                <input type="number" min="0" max="100" step="0.1"
                  value={form.discount_pct} onChange={(e) => set('discount_pct', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Статус клієнта</label>
                <select value={form.client_status} onChange={(e) => set('client_status', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
                  <option value="client">Звичайний клієнт</option>
                  <option value="sto">СТО</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Штрих-код картки</label>
                <div className="flex gap-2">
                  <input value={form.card_barcode} onChange={(e) => set('card_barcode', e.target.value)}
                    placeholder="Згенерувати або ввести"
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
                  <button type="button" onClick={() => {
                      const barcode = '200' + String(Math.floor(Math.random() * 1_000_000_000)).padStart(10, '0')
                      set('card_barcode', barcode)
                    }}
                    className="px-3 py-2 bg-gray-100 text-gray-600 text-sm rounded-lg hover:bg-gray-200">Згенерувати</button>
                </div>
              </div>
            </div>

            {tiers.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Ціновий рівень</label>
                <select value={form.price_tier_id} onChange={(e) => set('price_tier_id', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
                  <option value="">Стандартна ціна (роздріб)</option>
                  {tiers.map((t) => (
                    <option key={t.id} value={t.id}>{t.name} (знижка {t.discount_pct}%)</option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Теги</label>
              <div className="flex gap-2 flex-wrap">
                {TAGS.map((tag) => (
                  <button key={tag} type="button" onClick={() => toggleTag(tag)}
                    className={
                      'px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ' +
                      (form.tags.includes(tag)
                        ? 'bg-yellow-100 border-yellow-400 text-yellow-800'
                        : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300')
                    }>
                    {tag}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Примітки</label>
              <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={3}
                placeholder="Нотатки про клієнта..."
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none" />
            </div>

            <div className="flex gap-3 pt-2">
              <Button type="submit" loading={saving} icon={<Save size={16} />}>
                {isEdit ? 'Зберегти зміни' : 'Створити клієнта'}
              </Button>
              <Button type="button" variant="secondary" onClick={() => navigate('/customers')}>
                Скасувати
              </Button>
            </div>
          </Card>
        </form>
      </div>
    </Layout>
  )
}
