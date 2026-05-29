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

  // Local state for new markup rule
  const [newMin, setNewMin] = useState('')
  const [newMax, setNewMax] = useState('')
  const [newPct, setNewPct] = useState('')
  const [isInfinity, setIsInfinity] = useState(false)

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
        markup_rules:       form.markup_rules,
      })
      toast.success('Налаштування збережено')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    } finally {
      setSaving(false)
    }
  }

  function addRule() {
    const minVal = parseFloat(newMin)
    const maxVal = isInfinity ? 99999999 : parseFloat(newMax)
    const pctVal = parseInt(newPct)

    if (isNaN(minVal) || minVal < 0) { toast.error('Введіть коректну ціну "Від"'); return }
    if (!isInfinity && (isNaN(maxVal) || maxVal <= minVal)) { toast.error('Ціна "До" має бути більшою за "Від"'); return }
    if (isNaN(pctVal) || pctVal < 0) { toast.error('Введіть коректний відсоток націнки'); return }

    const minCents = Math.round(minVal * 100)
    const maxCents = isInfinity ? 9999999900 : Math.round(maxVal * 100)

    const currentRules = form.markup_rules ?? []
    const updated = [...currentRules, { minPrice: minCents, maxPrice: maxCents, markupPct: pctVal }]
      .sort((a, b) => a.minPrice - b.minPrice)

    set('markup_rules', updated)
    setNewMin('')
    setNewMax('')
    setNewPct('')
    setIsInfinity(false)
  }

  function removeRule(index: number) {
    const currentRules = form.markup_rules ?? []
    const updated = currentRules.filter((_, i) => i !== index)
    set('markup_rules', updated)
  }

  if (loading) return (
    <Layout title="Налаштування магазину">
      <div className="flex items-center justify-center h-64 text-gray-400 text-sm">Завантаження...</div>
    </Layout>
  )

  const markupRules = form.markup_rules ?? []

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

          {/* ========== Матриця націнок ========== */}
          <Card className="mt-6 space-y-4">
            <div className="flex items-center gap-2 pb-3 border-b border-gray-100">
              <Percent size={18} className="text-yellow-500" />
              <h3 className="text-sm font-semibold text-gray-800">Матриця націнок</h3>
            </div>

            <div className="space-y-3">
              <p className="text-xs text-gray-400">
                Налаштуйте націнку (%) на товари залежно від діапазону закупівельної ціни. Діапазони вказуються в гривнях.
              </p>

              <div className="border border-gray-100 rounded-xl overflow-hidden">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-gray-400 text-[11px] font-bold uppercase tracking-wider">
                      <th className="px-4 py-3">Від (грн)</th>
                      <th className="px-4 py-3">До (грн)</th>
                      <th className="px-4 py-3">Націнка (%)</th>
                      <th className="px-4 py-3 text-right">Дії</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {markupRules.map((rule, idx) => (
                      <tr key={idx} className="hover:bg-gray-50/50">
                        <td className="px-4 py-3 font-medium text-gray-700">{(rule.minPrice / 100).toFixed(2)}</td>
                        <td className="px-4 py-3 font-medium text-gray-700">
                          {rule.maxPrice >= 9999999900 ? '∞' : (rule.maxPrice / 100).toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-gray-900 font-bold">{rule.markupPct}%</td>
                        <td className="px-4 py-3 text-right">
                          <button type="button" onClick={() => removeRule(idx)} className="text-red-500 hover:text-red-700 text-xs font-semibold cursor-pointer">
                            Видалити
                          </button>
                        </td>
                      </tr>
                    ))}
                    {markupRules.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-4 py-6 text-center text-gray-400 text-xs">
                          Немає налаштованих правил націнки
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Форма додавання правила */}
              <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 flex flex-col md:flex-row gap-3 items-end">
                <div className="flex-1 w-full">
                  <label className="block text-xs font-semibold text-gray-500 mb-1">Ціна від (грн)</label>
                  <input type="number" min={0} step={0.01} value={newMin} onChange={(e) => setNewMin(e.target.value)}
                    className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300" />
                </div>
                <div className="flex-1 w-full">
                  <div className="flex justify-between items-center mb-1">
                    <label className="block text-xs font-semibold text-gray-500">Ціна до (грн)</label>
                    <label className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-500 cursor-pointer">
                      <input type="checkbox" checked={isInfinity} onChange={(e) => setIsInfinity(e.target.checked)} className="rounded text-yellow-400 focus:ring-yellow-300" />
                      Безкінечність
                    </label>
                  </div>
                  <input type="number" min={0} step={0.01} disabled={isInfinity} value={isInfinity ? '' : newMax} onChange={(e) => setNewMax(e.target.value)}
                    className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300 disabled:bg-gray-100 disabled:text-gray-400" />
                </div>
                <div className="flex-1 w-full">
                  <label className="block text-xs font-semibold text-gray-500 mb-1">Націнка (%)</label>
                  <input type="number" min={0} step={1} value={newPct} onChange={(e) => setNewPct(e.target.value)}
                    className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300" />
                </div>
                <button type="button" onClick={addRule} className="bg-yellow-400 hover:bg-yellow-300 text-gray-900 font-bold px-4 py-2 rounded-lg text-sm transition-colors w-full md:w-auto h-[38px] shrink-0 cursor-pointer">
                  Додати
                </button>
              </div>
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
