import { useState, useEffect, useRef } from 'react'
import { Save, Star, Lock, Users, Plus, Trash2, ChevronDown, ChevronRight, ArrowUp, ArrowDown, Zap } from 'lucide-react'
import { adminApi } from './adminApi'
import type { ShopSettings, QuickItemConfig } from './adminApi'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { Layout } from '@/components/Layout'
import { Button, Card, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

const EMOJI_PRESETS = ['📦','☕','🌭','🍕','🥤','🍔','🍩','🛍','⚙️','🔧','🔑','💊','🚗','📱','💡','🎁','🏷️','🛒','💰','✅','🧃','🫙','🍫','🧁','🍟','🥪','🧋','🍿']

interface LoyaltySettings {
  is_enabled:           boolean
  accrual_pct:          number
  max_redeem_pct:       number
  min_purchase_kopecks: number
  expiry_days:          number | null
}

export default function SettingsPage() {
  const session = useAuthStore((s) => s.session)
  const [form, setForm]         = useState<Partial<ShopSettings>>({})
  const [loyalty, setLoyalty]   = useState<LoyaltySettings>({
    is_enabled: false, accrual_pct: 2, max_redeem_pct: 30,
    min_purchase_kopecks: 10000, expiry_days: null,
  })
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)
  const [savingLoyalty, setSavingLoyalty] = useState(false)

  // Паролі
  const [myPassword, setMyPassword] = useState('')
  const [users, setUsers] = useState<Array<{ id: string; full_name: string; role: string }>>([])
  const [selectedUserId, setSelectedUserId] = useState('')
  const [userPassword, setUserPassword] = useState('')

  // Швидкі товари POS
  const [quickItems, setQuickItems]   = useState<QuickItemConfig[]>([])
  const [savingQuick, setSavingQuick] = useState(false)
  const [expandedItem, setExpandedItem] = useState<number | null>(null)
  const [emojiPickerIdx, setEmojiPickerIdx] = useState<number | null>(null)
  const [categories, setCategories]   = useState<string[]>([])
  const emojiPickerRef = useRef<HTMLDivElement>(null)

  // Закриваємо emoji picker при кліку поза ним
  useEffect(() => {
    if (emojiPickerIdx === null) return
    function onOutside(e: MouseEvent) {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setEmojiPickerIdx(null)
      }
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [emojiPickerIdx])

  // Завантажуємо користувачів для зміни пароля
  useEffect(() => {
    if (['owner', 'admin'].includes(session?.user?.user_metadata?.role)) {
      api.get<{ data: Array<{ id: string; full_name: string; role: string }> }>('/api/v1/admin/users')
        .then((r) => setUsers(r.data)).catch(() => {})
    }
  }, [session])

  async function handleMyPassword() {
    if (!myPassword || myPassword.length < 4) { toast.error('Мінімум 4 символи'); return }
    try {
      await api.post('/api/v1/auth/change-password', { password: myPassword })
      setMyPassword('')
      toast.success('Пароль змінено')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
  }

  async function handleUserPassword() {
    if (!selectedUserId) { toast.error('Оберіть користувача'); return }
    if (!userPassword || userPassword.length < 4) { toast.error('Мінімум 4 символи'); return }
    try {
      await api.post('/api/v1/auth/change-password', { user_id: selectedUserId, password: userPassword })
      setUserPassword('')
      toast.success('Пароль користувача змінено')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
  }

  useEffect(() => {
    Promise.all([
      adminApi.getSettings(),
      api.get<{ data: LoyaltySettings }>('/api/v1/loyalty/settings'),
      adminApi.listCategories(),
    ]).then(([shopRes, loyaltyRes, catsRes]) => {
      setForm(shopRes.data)
      setLoyalty(loyaltyRes.data)
      setQuickItems(shopRes.data.pos_quick_items ?? [])
      setCategories(catsRes.data.map((c) => c.name))
    }).catch(() => toast.error('Помилка завантаження налаштувань'))
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

        {/* ⚡ Нижній дашборд POS */}
        <Card className="mt-6 space-y-5">
          <div className="flex items-center justify-between pb-2 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <Zap size={16} className="text-yellow-500" />
              <h3 className="text-sm font-semibold text-gray-800">Нижній дашборд (швидкі кнопки)</h3>
            </div>
            <span className="text-[11px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{quickItems.length} / 6</span>
          </div>

          {/* Live preview */}
          <div className="rounded-xl overflow-hidden border border-gray-200">
            <p className="text-[10px] text-gray-400 text-center bg-gray-50 py-1 border-b border-gray-200">Попередній перегляд</p>
            <div className="bg-[#0D0D0D] flex min-h-[64px]">
              {quickItems.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                  <span className="text-[11px] text-gray-600">Немає кнопок — додайте нижче</span>
                </div>
              ) : quickItems.slice(0, 6).map((item, i) => (
                <div key={i}
                  className="flex-1 flex flex-col items-center justify-center py-2 border-r border-black/40 last:border-r-0 gap-0.5"
                  style={{ background: item.color ?? '#2C2C2C' }}>
                  <span className="text-lg leading-none">{item.emoji ?? '📦'}</span>
                  <span className="text-[9px] text-white font-bold uppercase tracking-wide text-center px-0.5 line-clamp-1">{item.label || '—'}</span>
                  {item.type !== 'food_popup' && (item.price ?? 0) > 0 && (
                    <span className="text-[9px] text-white/70 font-mono">{((item.price ?? 0) / 100).toFixed(0)}₴</span>
                  )}
                  {item.type === 'food_popup' && (
                    <span className="text-[8px] text-white/50">▤ меню</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Список кнопок */}
          <div className="space-y-3">
            {quickItems.map((item, idx) => {
              const isFood = item.type === 'food_popup'
              return (
                <div key={idx} className="border border-gray-200 rounded-xl p-3 space-y-3 bg-gray-50/50">

                  {/* Рядок 1: переміщення + емодзі + назва + тип + видалити */}
                  <div className="flex items-start gap-2">
                    {/* Переміщення */}
                    <div className="flex flex-col gap-0.5 pt-1 shrink-0">
                      <button type="button" disabled={idx === 0}
                        onClick={() => {
                          const next = [...quickItems]
                          ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
                          setQuickItems(next)
                        }}
                        className="p-0.5 rounded text-gray-400 hover:text-gray-700 disabled:opacity-20">
                        <ArrowUp size={13} />
                      </button>
                      <button type="button" disabled={idx === quickItems.length - 1}
                        onClick={() => {
                          const next = [...quickItems]
                          ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
                          setQuickItems(next)
                        }}
                        className="p-0.5 rounded text-gray-400 hover:text-gray-700 disabled:opacity-20">
                        <ArrowDown size={13} />
                      </button>
                    </div>

                    {/* Емодзі */}
                    <div className="relative shrink-0">
                      <button type="button"
                        onClick={() => setEmojiPickerIdx(emojiPickerIdx === idx ? null : idx)}
                        className="w-12 h-12 rounded-xl border-2 border-gray-200 flex items-center justify-center text-2xl hover:border-yellow-400 transition-colors"
                        style={{ background: item.color ?? '#2C2C2C' }}>
                        {item.emoji ?? '📦'}
                      </button>
                      {emojiPickerIdx === idx && (
                        <div ref={emojiPickerRef} className="absolute left-0 top-full mt-1 z-20 bg-white border border-gray-200 rounded-xl shadow-lg p-2 w-52">
                          <div className="grid grid-cols-7 gap-1">
                            {EMOJI_PRESETS.map((e) => (
                              <button key={e} type="button"
                                onClick={() => {
                                  const next = [...quickItems]
                                  next[idx] = { ...next[idx], emoji: e }
                                  setQuickItems(next)
                                  setEmojiPickerIdx(null)
                                }}
                                className="text-xl p-1 rounded hover:bg-yellow-50 transition-colors">
                                {e}
                              </button>
                            ))}
                          </div>
                          <input
                            placeholder="Свій емодзі..."
                            className="mt-1 w-full text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none"
                            onChange={(e) => {
                              const next = [...quickItems]
                              next[idx] = { ...next[idx], emoji: e.target.value }
                              setQuickItems(next)
                            }} />
                        </div>
                      )}
                    </div>

                    {/* Назва */}
                    <div className="flex-1">
                      <label className="block text-xs text-gray-500 mb-1">Назва кнопки</label>
                      <input value={item.label}
                        onChange={(e) => {
                          const next = [...quickItems]; next[idx] = { ...next[idx], label: e.target.value }; setQuickItems(next)
                        }}
                        placeholder="КАВА, ПАКЕТ..."
                        className="w-full text-sm font-semibold border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-yellow-400" />
                    </div>

                    {/* Тип */}
                    <div className="shrink-0">
                      <label className="block text-xs text-gray-500 mb-1">Тип</label>
                      <select value={item.type ?? 'static'}
                        onChange={(e) => {
                          const next = [...quickItems]
                          next[idx] = { ...next[idx], type: e.target.value as 'static' | 'food_popup' }
                          setQuickItems(next)
                        }}
                        className="text-sm border border-gray-200 rounded-lg px-2 py-2 focus:outline-none focus:ring-2 focus:ring-yellow-400 bg-white">
                        <option value="static">Звичайний</option>
                        <option value="food_popup">Меню / Категорії</option>
                      </select>
                    </div>

                    {/* Видалити */}
                    <button type="button"
                      onClick={() => setQuickItems((prev) => prev.filter((_, i) => i !== idx))}
                      className="mt-5 p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors shrink-0">
                      <Trash2 size={16} />
                    </button>
                  </div>

                  {/* Рядок 2: Колір + SKU + Ціна (тільки static) / Категорії (тільки food_popup) */}
                  <div className="flex items-end gap-3 pl-14">
                    {/* Колір */}
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Колір</label>
                      <div className="flex items-center gap-1.5">
                        <input type="color" value={item.color ?? '#2C2C2C'}
                          onChange={(e) => {
                            const next = [...quickItems]; next[idx] = { ...next[idx], color: e.target.value }; setQuickItems(next)
                          }}
                          className="w-9 h-9 rounded-lg border border-gray-300 cursor-pointer p-0.5" />
                        <input type="text" value={item.color ?? '#2C2C2C'}
                          onChange={(e) => {
                            const next = [...quickItems]; next[idx] = { ...next[idx], color: e.target.value }; setQuickItems(next)
                          }}
                          className="w-24 text-xs border border-gray-200 rounded-lg px-2 py-2" />
                      </div>
                    </div>

                    {!isFood ? (
                      <>
                        {/* SKU */}
                        <div className="flex-1">
                          <label className="block text-xs text-gray-500 mb-1">SKU товару</label>
                          <input value={item.sku}
                            onChange={(e) => {
                              const next = [...quickItems]; next[idx] = { ...next[idx], sku: e.target.value }; setQuickItems(next)
                            }}
                            placeholder="COFFEE"
                            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-yellow-400" />
                        </div>
                        {/* Ціна */}
                        <div className="w-28">
                          <label className="block text-xs text-gray-500 mb-1">Ціна (грн)</label>
                          <input type="number" min="0" step="0.01"
                            value={((item.price ?? 0) / 100).toFixed(2)}
                            onChange={(e) => {
                              const next = [...quickItems]
                              next[idx] = { ...next[idx], price: Math.round(parseFloat(e.target.value || '0') * 100) }
                              setQuickItems(next)
                            }}
                            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-yellow-400" />
                        </div>
                      </>
                    ) : (
                      /* Категорії для food_popup */
                      <div className="flex-1">
                        <label className="block text-xs text-gray-500 mb-1">Категорії товарів (показувати в меню)</label>
                        {categories.length === 0 ? (
                          <p className="text-xs text-gray-400">Завантаження категорій...</p>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {categories.map((cat) => {
                              const selected = (item.category_filter ?? []).includes(cat)
                              return (
                                <button key={cat} type="button"
                                  onClick={() => {
                                    const current = item.category_filter ?? []
                                    const updated = selected
                                      ? current.filter((c) => c !== cat)
                                      : [...current, cat]
                                    const next = [...quickItems]
                                    next[idx] = { ...next[idx], category_filter: updated }
                                    setQuickItems(next)
                                  }}
                                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                                    selected
                                      ? 'bg-yellow-400 border-yellow-400 text-black font-semibold'
                                      : 'bg-white border-gray-300 text-gray-600 hover:border-gray-400'
                                  }`}>
                                  {cat}
                                </button>
                              )
                            })}
                          </div>
                        )}
                        {(item.category_filter ?? []).length === 0 && (
                          <p className="text-[11px] text-orange-500 mt-1">⚠ Оберіть хоча б одну категорію</p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Варіанти — тільки для static */}
                  {!isFood && (
                    <div className="pl-14">
                      <button type="button"
                        onClick={() => setExpandedItem(expandedItem === idx ? null : idx)}
                        className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
                        {expandedItem === idx ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        Варіанти ({item.children?.length ?? 0})
                        <span className="text-[10px] text-gray-400 ml-1">— при кліку відкривається вибір</span>
                      </button>
                      {expandedItem === idx && (
                        <div className="mt-2 space-y-2 pl-3 border-l-2 border-gray-200">
                          {(item.children ?? []).map((child, ci) => (
                            <div key={ci} className="flex items-center gap-2">
                              <input value={child.label}
                                onChange={(e) => {
                                  const next = [...quickItems]
                                  const children = [...(next[idx].children ?? [])]
                                  children[ci] = { ...children[ci], label: e.target.value }
                                  next[idx] = { ...next[idx], children }
                                  setQuickItems(next)
                                }}
                                placeholder="Назва" className="flex-1 text-xs border border-gray-200 rounded px-2 py-1.5" />
                              <input value={child.sku}
                                onChange={(e) => {
                                  const next = [...quickItems]
                                  const children = [...(next[idx].children ?? [])]
                                  children[ci] = { ...children[ci], sku: e.target.value }
                                  next[idx] = { ...next[idx], children }
                                  setQuickItems(next)
                                }}
                                placeholder="SKU" className="w-24 text-xs border border-gray-200 rounded px-2 py-1.5" />
                              <input type="number" min="0" step="0.01"
                                value={((child.price ?? 0) / 100).toFixed(2)}
                                onChange={(e) => {
                                  const next = [...quickItems]
                                  const children = [...(next[idx].children ?? [])]
                                  children[ci] = { ...children[ci], price: Math.round(parseFloat(e.target.value || '0') * 100) }
                                  next[idx] = { ...next[idx], children }
                                  setQuickItems(next)
                                }}
                                placeholder="ціна" className="w-20 text-xs border border-gray-200 rounded px-2 py-1.5" />
                              <button type="button"
                                onClick={() => {
                                  const next = [...quickItems]
                                  next[idx] = { ...next[idx], children: (next[idx].children ?? []).filter((_, i) => i !== ci) }
                                  setQuickItems(next)
                                }}
                                className="text-red-400 hover:text-red-600 p-1">
                                <Trash2 size={13} />
                              </button>
                            </div>
                          ))}
                          <button type="button"
                            onClick={() => {
                              const next = [...quickItems]
                              next[idx] = { ...next[idx], children: [...(next[idx].children ?? []), { label: '', sku: '', price: 0 }] }
                              setQuickItems(next)
                            }}
                            className="text-xs text-blue-500 hover:text-blue-700 flex items-center gap-1">
                            <Plus size={12} /> Додати варіант
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {quickItems.length < 6 ? (
            <div className="flex gap-2">
              <button type="button"
                onClick={() => setQuickItems((p) => [...p, { sku: `item_${Date.now()}`, label: '', emoji: '📦', price: 0, color: '#2C2C2C', type: 'static', children: [] }])}
                className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1 px-3 py-2 border border-dashed border-blue-300 rounded-lg hover:bg-blue-50 transition-colors">
                <Plus size={14} /> Звичайна кнопка
              </button>
              <button type="button"
                onClick={() => setQuickItems((p) => [...p, { sku: `food_${Date.now()}`, label: 'ЇЖА', emoji: '🍕', price: 0, color: '#7C2D12', type: 'food_popup', category_filter: [], children: [] }])}
                className="text-sm text-orange-600 hover:text-orange-800 flex items-center gap-1 px-3 py-2 border border-dashed border-orange-300 rounded-lg hover:bg-orange-50 transition-colors">
                <Plus size={14} /> Кнопка-меню (їжа / категорії)
              </button>
            </div>
          ) : (
            <p className="text-xs text-gray-400">Максимум 6 кнопок досягнуто</p>
          )}

          <Button type="button" loading={savingQuick} icon={<Save size={16} />}
            onClick={async () => {
              setSavingQuick(true)
              try {
                await adminApi.updateSettings({ pos_quick_items: quickItems })
                toast.success('Дашборд збережено')
              } catch { toast.error('Помилка збереження') }
              finally { setSavingQuick(false) }
            }}>
            Зберегти дашборд
          </Button>
        </Card>

        {/* Лояльність */}
        <Card className="mt-6 space-y-4">
          <div className="flex items-center gap-2 pb-2 border-b border-gray-100">
            <Star size={16} className="text-yellow-500" />
            <h3 className="text-sm font-semibold text-gray-800">Програма лояльності</h3>
          </div>

          <div className="flex items-center gap-3">
            <input type="checkbox" id="loyalty_enabled"
              checked={loyalty.is_enabled}
              onChange={(e) => setLoyalty((l) => ({ ...l, is_enabled: e.target.checked }))}
              className="w-4 h-4 accent-yellow-400" />
            <label htmlFor="loyalty_enabled" className="text-sm text-gray-700 font-medium">
              Увімкнути бонусну програму
            </label>
          </div>

          {loyalty.is_enabled && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Нарахування бонусів (% від суми покупки)
                </label>
                <input type="number" min={0} max={100} step={0.1}
                  value={loyalty.accrual_pct}
                  onChange={(e) => setLoyalty((l) => ({ ...l, accrual_pct: parseFloat(e.target.value) }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Максимальне списання (% від суми чека)
                </label>
                <input type="number" min={0} max={100} step={1}
                  value={loyalty.max_redeem_pct}
                  onChange={(e) => setLoyalty((l) => ({ ...l, max_redeem_pct: parseFloat(e.target.value) }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Мінімальна сума покупки для нарахування (грн)
                </label>
                <input type="number" min={0} step={1}
                  value={(loyalty.min_purchase_kopecks / 100).toFixed(0)}
                  onChange={(e) => setLoyalty((l) => ({ ...l, min_purchase_kopecks: Math.round(parseFloat(e.target.value) * 100) }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              </div>
            </div>
          )}

          <Button
            type="button"
            variant="secondary"
            loading={savingLoyalty}
            icon={<Save size={16} />}
            onClick={async () => {
              setSavingLoyalty(true)
              try {
                await api.put('/api/v1/loyalty/settings', loyalty)
                toast.success('Налаштування лояльності збережено')
              } catch {
                toast.error('Помилка збереження')
              } finally {
                setSavingLoyalty(false)
              }
            }}
          >
            Зберегти лояльність
          </Button>
        </Card>

        {/* Зміна пароля */}
        <Card className="mt-6 space-y-4">
          <div className="flex items-center gap-2 pb-2 border-b border-gray-100">
            <Lock size={16} className="text-gray-500" />
            <h3 className="text-sm font-semibold text-gray-800">Безпека</h3>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Новий пароль (свій)</label>
              <div className="flex gap-2">
                <input type="password" id="my_password"
                  value={myPassword}
                  onChange={(e) => setMyPassword(e.target.value)}
                  minLength={4} placeholder="Мінімум 4 символи"
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
                <Button size="sm" onClick={handleMyPassword}>Змінити</Button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                <Users size={14} className="inline mr-1" />
                Змінити пароль користувача
              </label>
              <div className="flex gap-2">
                <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)}
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
                  <option value="">— Оберіть —</option>
                  {users.filter((u) => u.id !== session?.user?.id).map((u) => (
                    <option key={u.id} value={u.id}>{u.full_name} ({u.role})</option>
                  ))}
                </select>
                <input type="password" id="user_password"
                  value={userPassword}
                  onChange={(e) => setUserPassword(e.target.value)}
                  minLength={4} placeholder="Пароль"
                  className="w-28 border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
                <Button size="sm" onClick={handleUserPassword}>OK</Button>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </Layout>
  )
}
