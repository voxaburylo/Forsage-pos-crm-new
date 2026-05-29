import { useState, useEffect } from 'react'
import { Save, Store, MapPin, Percent, RotateCcw, CreditCard, Ban, Plus, Trash2, ArrowUp, ArrowDown, Pencil, X, Zap, Users } from 'lucide-react'
import { adminApi } from '@/features/admin/adminApi'
import type { ShopSettings, QuickItemConfig, QuickChildItem } from '@/features/admin/adminApi'
import { Layout } from '@/components/Layout'
import { Button, Card, Input, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'

// ─── Emoji picker (compact) ─────────────────────────────────────
const EMOJI_OPTIONS = ['📦','🛍','⚙️','🍕','☕','🔧','💡','🎁','🧴','🔑','🚗','🏷️','📱','💧','🧲','🪫']

// ─── Color picker ────────────────────────────────────────────────
const COLOR_OPTIONS = [
  '#2C2C2C','#7C2D12','#065F46','#075985','#6B21A8',
  '#9F1239','#854D0E','#1E3A5F','#312E81','#064E3B',
]

export default function SettingsPage() {
  const [form, setForm]     = useState<Partial<ShopSettings>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)

  // Local state for new markup rule
  const [newMin, setNewMin] = useState('')
  const [newMax, setNewMax] = useState('')
  const [newPct, setNewPct] = useState('')
  const [isInfinity, setIsInfinity] = useState(false)

  // Quick item edit modal
  const [editIdx, setEditIdx]             = useState<number | null>(null)
  const [editItem, setEditItem]           = useState<QuickItemConfig | null>(null)
  const [addChildOpen, setAddChildOpen]   = useState(false)
  const [childLabel, setChildLabel]       = useState('')
  const [childSku, setChildSku]           = useState('')
  const [childPrice, setChildPrice]       = useState('')

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
        pos_quick_items:    form.pos_quick_items,
        employee_discount_pct: form.employee_discount_pct,
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

  // ─── POS Quick Items helpers ───────────────────────────────────
  const quickItems = form.pos_quick_items ?? []

  function setQuickItems(items: QuickItemConfig[]) {
    set('pos_quick_items', items)
  }

  function addQuickItem() {
    const idx = quickItems.length + 1
    const newItem: QuickItemConfig = {
      sku: `BTN${idx}`,
      label: `Кнопка ${idx}`,
      emoji: '📦',
      price: 0,
      color: COLOR_OPTIONS[idx % COLOR_OPTIONS.length],
      children: [],
      type: 'static',
      category_filter: [],
    }
    setQuickItems([...quickItems, newItem])
  }

  function removeQuickItem(idx: number) {
    setQuickItems(quickItems.filter((_, i) => i !== idx))
  }

  function moveItem(idx: number, dir: -1 | 1) {
    const target = idx + dir
    if (target < 0 || target >= quickItems.length) return
    const arr = [...quickItems]
    ;[arr[idx], arr[target]] = [arr[target], arr[idx]]
    setQuickItems(arr)
  }

  function openEditModal(idx: number) {
    setEditIdx(idx)
    setEditItem({ ...quickItems[idx], children: [...(quickItems[idx].children ?? [])] })
  }

  function saveEditItem() {
    if (editIdx === null || !editItem) return
    if (!editItem.sku.trim() || !editItem.label.trim()) { toast.error('SKU та назва обов\'язкові'); return }
    const arr = [...quickItems]
    arr[editIdx] = editItem
    setQuickItems(arr)
    setEditIdx(null)
    setEditItem(null)
  }

  function addChild() {
    if (!editItem || !childLabel.trim()) { toast.error('Вкажіть назву'); return }
    const child: QuickChildItem = {
      label: childLabel.trim(),
      sku: childSku.trim() || `${editItem.sku}_${(editItem.children?.length ?? 0) + 1}`,
      price: childPrice ? Math.round(parseFloat(childPrice) * 100) : 0,
    }
    setEditItem({ ...editItem, children: [...(editItem.children ?? []), child] })
    setChildLabel('')
    setChildSku('')
    setChildPrice('')
    setAddChildOpen(false)
  }

  function removeChild(childIdx: number) {
    if (!editItem) return
    setEditItem({ ...editItem, children: (editItem.children ?? []).filter((_, i) => i !== childIdx) })
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

            {/* Знижка для працівників */}
            <div className="pt-2 border-t border-gray-100">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                <Users size={14} className="inline mr-1" />
                Знижка для працівників (%)
              </label>
              <input type="number" min={0} max={100} step={1}
                value={form.employee_discount_pct ?? 0}
                onChange={(e) => set('employee_discount_pct', parseFloat(e.target.value) || 0)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              <p className="text-xs text-gray-400 mt-1">
                Автоматична знижка при виборі «Продаж працівнику» в касі
              </p>
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

          {/* ========== Швидкі кнопки POS ========== */}
          <Card className="mt-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Zap size={18} className="text-purple-500" />
                <h3 className="text-sm font-semibold text-gray-800">Швидкі кнопки POS</h3>
              </div>
              <span className="text-xs text-gray-400">{quickItems.length} кнопок</span>
            </div>

            <p className="text-xs text-gray-400">
              Кнопки відображаються внизу екрану каси. Максимум 8 кнопок. Кожна кнопка може мати підменю з дочірніми товарами.
            </p>

            {/* Quick items list */}
            <div className="space-y-2">
              {quickItems.map((item, idx) => (
                <div key={idx} className="flex items-center gap-2 p-3 rounded-xl border border-gray-100 hover:border-gray-200 transition-colors bg-white group">
                  {/* Preview chip */}
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center text-white text-lg shrink-0 shadow-sm"
                    style={{ background: item.color ?? '#2C2C2C' }}>
                    {item.emoji ?? '📦'}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-gray-800 truncate">{item.label}</p>
                    <p className="text-[11px] text-gray-400 flex gap-2">
                      <span>SKU: {item.sku}</span>
                      {item.price && item.price > 0 && <span>• {formatMoney(item.price)}</span>}
                      {item.type === 'food_popup' && <span className="text-purple-500">• Меню категорій</span>}
                      {(item.children?.length ?? 0) > 0 && <span className="text-blue-500">• {item.children!.length} підтоварів</span>}
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button type="button" onClick={() => moveItem(idx, -1)} disabled={idx === 0}
                      className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 disabled:opacity-30" title="Вгору">
                      <ArrowUp size={14} />
                    </button>
                    <button type="button" onClick={() => moveItem(idx, 1)} disabled={idx === quickItems.length - 1}
                      className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 disabled:opacity-30" title="Вниз">
                      <ArrowDown size={14} />
                    </button>
                    <button type="button" onClick={() => openEditModal(idx)}
                      className="p-1.5 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-500" title="Редагувати">
                      <Pencil size={14} />
                    </button>
                    <button type="button" onClick={() => removeQuickItem(idx)}
                      className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500" title="Видалити">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}

              {quickItems.length === 0 && (
                <div className="text-center py-8 text-gray-400 text-sm">
                  Немає кнопок. Додайте першу кнопку нижче.
                </div>
              )}
            </div>

            {quickItems.length < 8 && (
              <button type="button" onClick={addQuickItem}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 border-dashed border-gray-200 text-gray-400 hover:border-purple-300 hover:text-purple-500 text-sm font-medium transition-colors cursor-pointer">
                <Plus size={16} />
                Додати кнопку
              </button>
            )}
          </Card>

          {/* ========== Зберегти ========== */}
          <div className="mt-6">
            <Button type="submit" loading={saving} icon={<Save size={16} />}>
              Зберегти налаштування
            </Button>
          </div>
        </form>
      </div>

      {/* ═══════════════════════════════════════════════════════════
           Модальне вікно — Редагування кнопки
         ═══════════════════════════════════════════════════════════ */}
      <Modal
        open={editIdx !== null}
        onClose={() => { setEditIdx(null); setEditItem(null) }}
        title="Редагувати кнопку"
        size="md"
      >
        {editItem && (
          <div className="space-y-4">
            {/* Основні поля */}
            <div className="grid grid-cols-2 gap-3">
              <Input label="SKU *" value={editItem.sku}
                onChange={(e) => setEditItem({ ...editItem, sku: e.target.value })} />
              <Input label="Назва *" value={editItem.label}
                onChange={(e) => setEditItem({ ...editItem, label: e.target.value })} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Ціна (грн), 0 = з бази</label>
                <input type="number" min={0} step={0.01}
                  value={editItem.price ? (editItem.price / 100).toFixed(2) : ''}
                  onChange={(e) => setEditItem({ ...editItem, price: Math.round(parseFloat(e.target.value || '0') * 100) })}
                  placeholder="0.00"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Тип</label>
                <select value={editItem.type ?? 'static'}
                  onChange={(e) => setEditItem({ ...editItem, type: e.target.value as 'static' | 'food_popup' })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent bg-white">
                  <option value="static">Статичний</option>
                  <option value="food_popup">Меню категорій</option>
                </select>
              </div>
            </div>

            {/* Фільтр категорій (для food_popup) */}
            {editItem.type === 'food_popup' && (
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">
                  Категорії (через кому)
                </label>
                <input
                  value={(editItem.category_filter ?? []).join(', ')}
                  onChange={(e) => setEditItem({
                    ...editItem,
                    category_filter: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                  })}
                  placeholder="Кава та напої, Снеки та хотдоги"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
                <p className="text-xs text-gray-400 mt-1">Назви категорій з каталогу</p>
              </div>
            )}

            {/* Emoji */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Емодзі</label>
              <div className="flex flex-wrap gap-1.5">
                {EMOJI_OPTIONS.map((em) => (
                  <button key={em} type="button"
                    onClick={() => setEditItem({ ...editItem, emoji: em })}
                    className={`w-9 h-9 rounded-lg text-lg flex items-center justify-center transition-all cursor-pointer ${editItem.emoji === em ? 'ring-2 ring-yellow-400 bg-yellow-50 scale-110' : 'bg-gray-50 hover:bg-gray-100'}`}>
                    {em}
                  </button>
                ))}
              </div>
            </div>

            {/* Color */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Колір</label>
              <div className="flex flex-wrap gap-1.5">
                {COLOR_OPTIONS.map((col) => (
                  <button key={col} type="button"
                    onClick={() => setEditItem({ ...editItem, color: col })}
                    className={`w-9 h-9 rounded-lg transition-all cursor-pointer ${editItem.color === col ? 'ring-2 ring-yellow-400 scale-110' : 'hover:scale-105'}`}
                    style={{ background: col }} />
                ))}
              </div>
            </div>

            {/* Preview */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-2">Превʼю</label>
              <div className="flex justify-center">
                <div className="w-28 h-20 rounded-xl flex flex-col items-center justify-center text-white font-bold shadow-lg"
                  style={{ background: editItem.color ?? '#2C2C2C' }}>
                  <span className="text-2xl">{editItem.emoji ?? '📦'}</span>
                  <span className="text-[10px] font-bold mt-0.5 uppercase tracking-wide">{editItem.label}</span>
                  {(editItem.price ?? 0) > 0 && (
                    <span className="text-[10px] font-mono text-white/80">{formatMoney(editItem.price!)}</span>
                  )}
                </div>
              </div>
            </div>

            {/* Children (submenu items) */}
            {editItem.type !== 'food_popup' && (
              <div className="border-t border-gray-100 pt-3">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-gray-500">Підменю ({(editItem.children ?? []).length})</label>
                  <button type="button" onClick={() => setAddChildOpen(true)}
                    className="text-xs text-purple-500 hover:text-purple-700 font-semibold flex items-center gap-1 cursor-pointer">
                    <Plus size={12} /> Додати
                  </button>
                </div>
                {(editItem.children ?? []).length === 0 ? (
                  <p className="text-xs text-gray-400 text-center py-3">Немає дочірніх товарів</p>
                ) : (
                  <div className="space-y-1.5">
                    {editItem.children!.map((child, ci) => (
                      <div key={ci} className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg text-sm">
                        <span className="font-medium text-gray-700 flex-1">{child.label}</span>
                        <span className="text-gray-400 text-xs">{child.sku}</span>
                        <span className="text-gray-500 font-mono text-xs">
                          {(child.price ?? 0) > 0 ? formatMoney(child.price!) : 'з бази'}
                        </span>
                        <button type="button" onClick={() => removeChild(ci)}
                          className="text-red-400 hover:text-red-600 p-1 cursor-pointer"><X size={12} /></button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Inline add child form */}
                {addChildOpen && (
                  <div className="mt-3 p-3 bg-purple-50 rounded-xl border border-purple-100 space-y-2">
                    <div className="grid grid-cols-3 gap-2">
                      <Input label="Назва *" value={childLabel}
                        onChange={(e) => setChildLabel(e.target.value)} autoFocus />
                      <Input label="SKU" value={childSku}
                        onChange={(e) => setChildSku(e.target.value)} placeholder="auto" />
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 mb-1">Ціна (грн)</label>
                        <input type="number" min={0} step={0.01} value={childPrice}
                          onChange={(e) => setChildPrice(e.target.value)} placeholder="0 = з бази"
                          className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent bg-white" />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" onClick={addChild}
                        className="bg-purple-500 hover:bg-purple-600 text-white font-bold px-3 py-1.5 rounded-lg text-xs transition-colors cursor-pointer">
                        Додати
                      </button>
                      <button type="button" onClick={() => setAddChildOpen(false)}
                        className="text-gray-400 hover:text-gray-600 text-xs font-semibold cursor-pointer">
                        Скасувати
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Save / Cancel */}
            <div className="flex gap-3 pt-2 border-t border-gray-100">
              <Button type="button" onClick={saveEditItem} className="flex-1">Зберегти</Button>
              <Button type="button" variant="secondary" onClick={() => { setEditIdx(null); setEditItem(null) }}>Скасувати</Button>
            </div>
          </div>
        )}
      </Modal>
    </Layout>
  )
}
