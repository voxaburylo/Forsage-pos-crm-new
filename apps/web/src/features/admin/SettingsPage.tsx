import { useState, useEffect } from 'react'
import { Save } from 'lucide-react'
import { adminApi } from './adminApi'
import type { ShopSettings } from './adminApi'
import { Layout } from '@/components/Layout'
import { Button, Card, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

export default function SettingsPage() {
  const [form, setForm]     = useState<Partial<ShopSettings>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)

  useEffect(() => {
    adminApi.getSettings()
      .then(({ data }) => setForm(data))
      .catch(() => toast.error('Помилка завантаження налаштувань'))
      .finally(() => setLoading(false))
  }, [])

  function set<K extends keyof ShopSettings>(key: K, value: ShopSettings[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await adminApi.updateSettings({
        shop_name:          form.shop_name,
        shop_address:       form.shop_address,
        phone:              form.phone,
        max_discount_pct:   form.max_discount_pct,
        allow_negative_qty: form.allow_negative_qty,
        return_days:        form.return_days,
      })
      toast.success('Налаштування збережено')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка збереження')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Layout><div className="flex items-center justify-center h-64 text-gray-400 text-sm">Завантаження...</div></Layout>

  return (
    <Layout title="Налаштування магазину">
      <div className="max-w-lg">
        <form onSubmit={handleSubmit}>
          <Card className="space-y-5">

            <Input label="Назва магазину" value={form.shop_name ?? ''} required
              onChange={(e) => set('shop_name', e.target.value)} />

            <Input label="Адреса" value={form.shop_address ?? ''}
              onChange={(e) => set('shop_address', e.target.value)}
              placeholder="вул. Перемоги 1, Запоріжжя" />

            <Input label="Телефон магазину" type="tel" value={form.phone ?? ''}
              onChange={(e) => set('phone', e.target.value)}
              placeholder="+380671234567" />

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Максимальна знижка без погодження (%)
              </label>
              <input type="number" min={0} max={100} step={0.1}
                value={form.max_discount_pct ?? 20}
                onChange={(e) => set('max_discount_pct', parseFloat(e.target.value))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Максимальний термін повернення (днів)
              </label>
              <input type="number" min={1} max={365}
                value={form.return_days ?? 14}
                onChange={(e) => set('return_days', parseInt(e.target.value))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>

            <div className="flex items-center gap-3">
              <input type="checkbox" id="negative_qty"
                checked={form.allow_negative_qty ?? true}
                onChange={(e) => set('allow_negative_qty', e.target.checked)}
                className="w-4 h-4 accent-yellow-400" />
              <label htmlFor="negative_qty" className="text-sm text-gray-700">
                Дозволити продаж при відсутності товару (мінусовий залишок)
              </label>
            </div>

            <Button type="submit" loading={saving} icon={<Save size={16} />}>
              Зберегти налаштування
            </Button>
          </Card>
        </form>
      </div>
    </Layout>
  )
}
