import { useState, useEffect } from 'react'
import { Save, Store, MapPin, Percent, RotateCcw, CreditCard, Ban } from 'lucide-react'
import { adminApi } from '@/features/admin/adminApi'
import type { ShopSettings } from '@/features/admin/adminApi'
import { Layout } from '@/components/Layout'
import { Button, Card, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'

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
        default_debt_limit_kopecks: form.default_debt_limit_kopecks,
      })
      toast.success('Налаштування збережено')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return (
    <Layout title="Налаштування магазину">
      <div className="flex items-center justify-center h-64 text-gray-400 text-sm">Завантаження...</div>
    </Layout>
  )

  return (
    <Layout title="Налаштування магазину">
      <div className="max-w-2xl">
        <form onSubmit={handleSubmit}>
          {/* ========== Основна інформація ========== */}
          <Card className="space-y-4">
            <div className="flex items-center gap-2 pb-3 border-b border-gray-100">
              <Store size={18} className="text-yellow-500" />
              <h3 className="text-sm font-semibold text-gray-800">Основна інформація</h3>
            </div>

            <Input label="Назва магазину *" value={form.shop_name ?? ''}
              onChange={(e) => set('shop_name', e.target.value)}
              placeholder="Форсаж Авто" required />

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                <MapPin size={14} className="inline mr-1" />
                Адреса
              </label>
              <input value={form.shop_address ?? ''}
                onChange={(e) => set('shop_address', e.target.value)}
                placeholder="м. Київ, вул. Автозапчастин, 1"
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>

            <Input label="Телефон для чеків" value={form.phone ?? ''}
              onChange={(e) => set('phone', e.target.value)}
              placeholder="+380671234567" />
          </Card>

          {/* ========== Правила продажу ========== */}
          <Card className="mt-6 space-y-4">
            <div className="flex items-center gap-2 pb-3 border-b border-gray-100">
              <CreditCard size={18} className="text-blue-500" />
              <h3 className="text-sm font-semibold text-gray-800">Правила продажу</h3>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                <Percent size={14} className="inline mr-1" />
                Максимальна знижка (%)
              </label>
              <input type="number" min={0} max={100} step={0.1}
                value={form.max_discount_pct ?? 0}
                onChange={(e) => set('max_discount_pct', parseFloat(e.target.value))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              <p className="text-xs text-gray-400 mt-1">Знижка понад це значення потребує підтвердження власника</p>
            </div>

            <div className="flex items-center justify-between py-2">
              <div className="flex items-start gap-3">
                <Ban size={18} className="text-gray-400 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-gray-700">Продаж при відсутності товару</p>
                  <p className="text-xs text-gray-400">Дозволити мінусовий залишок при продажу</p>
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox"
                  checked={form.allow_negative_qty ?? true}
                  onChange={(e) => set('allow_negative_qty', e.target.checked)}
                  className="sr-only peer" />
                <div className="w-9 h-5 bg-gray-200 rounded-full peer peer-checked:bg-yellow-400 peer-focus:ring-2 peer-focus:ring-yellow-200 after:content-[''] after:absolute after:top-0.5 after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
              </label>
            </div>
          </Card>

          {/* ========== Правила повернення ========== */}
          <Card className="mt-6 space-y-4">
            <div className="flex items-center gap-2 pb-3 border-b border-gray-100">
              <RotateCcw size={18} className="text-orange-500" />
              <h3 className="text-sm font-semibold text-gray-800">Правила повернення</h3>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                <RotateCcw size={14} className="inline mr-1" />
                Днів на повернення
              </label>
              <input type="number" min={1} max={365}
                value={form.return_days ?? 14}
                onChange={(e) => set('return_days', parseInt(e.target.value) || 14)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              <p className="text-xs text-gray-400 mt-1">Товар можна повернути протягом цього періоду</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                <CreditCard size={14} className="inline mr-1" />
                Ліміт боргу за замовчуванням
              </label>
              <input type="number" min={0}
                value={((form.default_debt_limit_kopecks ?? 100000) / 100).toFixed(0)}
                onChange={(e) => set('default_debt_limit_kopecks', Math.round(parseFloat(e.target.value) * 100))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              <p className="text-xs text-gray-400 mt-1">
                Поточний ліміт: {formatMoney(form.default_debt_limit_kopecks ?? 100000)}
              </p>
            </div>
          </Card>

          {/* ========== Зберегти ========== */}
          <div className="mt-6">
            <Button type="submit" loading={saving} icon={<Save size={16} />}>
              Зберегти налаштування
            </Button>
          </div>
        </form>
      </div>
    </Layout>
  )
}
