import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Edit3, Check, X } from 'lucide-react'
import { pricingApi } from './pricingApi'
import { adminApi } from './adminApi'
import type { PriceTier, CategoryMarkup } from './pricingApi'
import { Layout } from '@/components/Layout'
import { Button, Badge, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

interface Category { id: string; name: string }

export default function PricingPage() {
  const [tab, setTab]           = useState<'tiers' | 'markups'>('tiers')
  const [tiers, setTiers]       = useState<PriceTier[]>([])
  const [markups, setMarkups]   = useState<CategoryMarkup[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading]   = useState(true)

  // Форма нового рівня
  const [addingTier, setAddingTier]         = useState(false)
  const [newTierName, setNewTierName]       = useState('')
  const [newTierDiscount, setNewTierDiscount] = useState('0')
  const [newTierDefault, setNewTierDefault] = useState(false)
  const [savingTier, setSavingTier]         = useState(false)

  // Редагування наценки
  const [editMarkup, setEditMarkup]         = useState<string | null>(null)
  const [markupValue, setMarkupValue]       = useState('')
  const [minMarkupValue, setMinMarkupValue] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [tiersRes, markupsRes, catsRes] = await Promise.all([
        pricingApi.listTiers(),
        pricingApi.listMarkups(),
        adminApi.listCategories(),
      ])
      setTiers(tiersRes.data)
      setMarkups(markupsRes.data)
      setCategories(catsRes.data as Category[])
    } catch {
      toast.error('Помилка завантаження')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleAddTier() {
    if (!newTierName.trim()) { toast.error('Вкажіть назву рівня'); return }
    setSavingTier(true)
    try {
      await pricingApi.createTier({
        name:         newTierName.trim(),
        discount_pct: parseFloat(newTierDiscount) || 0,
        is_default:   newTierDefault,
      })
      setNewTierName(''); setNewTierDiscount('0'); setNewTierDefault(false); setAddingTier(false)
      load()
      toast.success('Рівень створено')
    } catch { toast.error('Помилка створення') } finally { setSavingTier(false) }
  }

  async function handleDeleteTier(id: string, name: string) {
    if (!confirm('Видалити рівень "' + name + '"? Клієнти з цим рівнем перейдуть на стандартну ціну.')) return
    try {
      await pricingApi.deleteTier(id)
      load(); toast.success('Рівень видалено')
    } catch { toast.error('Помилка видалення') }
  }

  async function handleSaveMarkup(categoryId: string) {
    const pct = parseFloat(markupValue)
    const minPct = parseFloat(minMarkupValue) || 0
    if (isNaN(pct) || pct < 0) { toast.error('Вкажіть коректний відсоток'); return }
    try {
      await pricingApi.upsertMarkup(categoryId, { markup_pct: pct, min_markup_pct: minPct })
      setEditMarkup(null); load(); toast.success('Наценку збережено')
    } catch { toast.error('Помилка збереження') }
  }

  async function handleDeleteMarkup(categoryId: string) {
    try {
      await pricingApi.deleteMarkup(categoryId)
      load(); toast.success('Наценку видалено')
    } catch { toast.error('Помилка видалення') }
  }

  function startEditMarkup(categoryId: string) {
    const existing = markups.find((m) => m.category_id === categoryId)
    setEditMarkup(categoryId)
    setMarkupValue(existing ? String(existing.markup_pct) : '30')
    setMinMarkupValue(existing ? String(existing.min_markup_pct) : '0')
  }

  const categoriesWithMarkup = new Set(markups.map((m) => m.category_id))

  return (
    <Layout title="Ціноутворення">
      <div className="flex gap-2 mb-6">
        {(['tiers', 'markups'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={
              'px-4 py-2 rounded-lg text-sm font-medium transition-colors ' +
              (tab === t ? 'bg-yellow-400 text-black' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300')
            }>
            {t === 'tiers' ? 'Цінові рівні' : 'Наценки категорій'}
          </button>
        ))}
      </div>

      {/* Цінові рівні */}
      {tab === 'tiers' && (
        <div className="max-w-2xl">
          <Card padding="none" className="mb-4">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <p className="text-sm font-semibold text-gray-800">Цінові рівні клієнтів</p>
              <Button size="sm" icon={<Plus size={14} />} onClick={() => setAddingTier(true)}>
                Додати
              </Button>
            </div>

            {addingTier && (
              <div className="px-4 py-3 border-b border-gray-100 bg-yellow-50 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Назва рівня</label>
                    <input value={newTierName} onChange={(e) => setNewTierName(e.target.value)}
                      placeholder="СТО, Оптовик, VIP..."
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Знижка (%)</label>
                    <input type="number" min="0" max="100" step="0.1"
                      value={newTierDiscount} onChange={(e) => setNewTierDiscount(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400" />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                  <input type="checkbox" checked={newTierDefault} onChange={(e) => setNewTierDefault(e.target.checked)} />
                  За замовчуванням для нових клієнтів
                </label>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleAddTier} disabled={savingTier}>Зберегти</Button>
                  <Button size="sm" variant="outline" onClick={() => setAddingTier(false)}>Скасувати</Button>
                </div>
              </div>
            )}

            {loading ? (
              <div className="py-8 text-center text-gray-400 text-sm">Завантаження...</div>
            ) : tiers.length === 0 ? (
              <div className="py-8 text-center text-gray-400 text-sm">
                <p>Рівнів немає</p>
                <p className="text-xs mt-1">За замовчуванням всі клієнти платять роздрібну ціну</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 uppercase border-b border-gray-100">
                    <th className="text-left px-4 py-2">Назва</th>
                    <th className="text-center px-4 py-2 w-28">Знижка</th>
                    <th className="text-center px-4 py-2 w-28">Статус</th>
                    <th className="w-16 px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((tier) => (
                    <tr key={tier.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="px-4 py-2 font-medium">{tier.name}</td>
                      <td className="px-4 py-2 text-center">
                        <span className="font-mono text-blue-600">-{tier.discount_pct}%</span>
                      </td>
                      <td className="px-4 py-2 text-center">
                        {tier.is_default && <Badge color="green">За замовч.</Badge>}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button onClick={() => handleDeleteTier(tier.id, tier.name)}
                          className="text-red-300 hover:text-red-500 p-1">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <p className="text-xs text-gray-400">
            Рівень призначається клієнту в картці клієнта. При продажу ціна автоматично коригується.
          </p>
        </div>
      )}

      {/* Наценки категорій */}
      {tab === 'markups' && (
        <div className="max-w-2xl">
          <Card padding="none">
            <div className="px-4 py-3 border-b border-gray-100">
              <p className="text-sm font-semibold text-gray-800">Наценки по категоріях</p>
              <p className="text-xs text-gray-400 mt-0.5">
                Роздрібна ціна = Закупівля × (1 + Наценка%). Мінімальна наценка захищає від збиткових знижок.
              </p>
            </div>

            {loading ? (
              <div className="py-8 text-center text-gray-400 text-sm">Завантаження...</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 uppercase border-b border-gray-100">
                    <th className="text-left px-4 py-2">Категорія</th>
                    <th className="text-center px-3 py-2 w-32">Наценка %</th>
                    <th className="text-center px-3 py-2 w-32">Мін. наценка %</th>
                    <th className="w-20 px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {categories.map((cat) => {
                    const markup = markups.find((m) => m.category_id === cat.id)
                    const isEditing = editMarkup === cat.id
                    return (
                      <tr key={cat.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                        <td className="px-4 py-2 font-medium">{cat.name}</td>
                        <td className="px-3 py-2 text-center">
                          {isEditing ? (
                            <input type="number" min="0" step="0.1" value={markupValue}
                              onChange={(e) => setMarkupValue(e.target.value)}
                              className="w-20 text-center border border-yellow-400 rounded px-2 py-1 text-sm focus:outline-none" />
                          ) : (
                            <span className={markup ? 'font-mono text-green-600' : 'text-gray-300'}>
                              {markup ? markup.markup_pct + '%' : '—'}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {isEditing ? (
                            <input type="number" min="0" step="0.1" value={minMarkupValue}
                              onChange={(e) => setMinMarkupValue(e.target.value)}
                              className="w-20 text-center border border-yellow-400 rounded px-2 py-1 text-sm focus:outline-none" />
                          ) : (
                            <span className="text-gray-400 text-xs">
                              {markup ? markup.min_markup_pct + '%' : '—'}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {isEditing ? (
                            <div className="flex items-center gap-1 justify-end">
                              <button onClick={() => handleSaveMarkup(cat.id)}
                                className="text-green-500 hover:text-green-700 p-1"><Check size={14} /></button>
                              <button onClick={() => setEditMarkup(null)}
                                className="text-gray-400 hover:text-gray-600 p-1"><X size={14} /></button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1 justify-end">
                              <button onClick={() => startEditMarkup(cat.id)}
                                className="text-gray-400 hover:text-gray-600 p-1"><Edit3 size={14} /></button>
                              {categoriesWithMarkup.has(cat.id) && (
                                <button onClick={() => handleDeleteMarkup(cat.id)}
                                  className="text-red-300 hover:text-red-500 p-1"><Trash2 size={14} /></button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}
    </Layout>
  )
}
