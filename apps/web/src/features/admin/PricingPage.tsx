import { useState, useEffect } from 'react'
import { Plus, Trash2, Save } from 'lucide-react'
import { adminApi } from './adminApi'
import { Layout } from '@/components/Layout'
import { Button, Card, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

interface MarkupRule {
  minPrice: number
  maxPrice: number
  markupPct: number
}

export default function PricingPage() {
  const [markupRules, setMarkupRules] = useState<MarkupRule[]>([])
  const [quickPercents, setQuickPercents] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    adminApi.getSettings().then((res) => {
      setMarkupRules(res.data.markup_rules || [])
      setQuickPercents(res.data.quick_percents || [])
      setLoading(false)
    }).catch(() => {
      toast.error('Помилка завантаження налаштувань')
      setLoading(false)
    })
  }, [])

  function handleSave() {
    setSaving(true)
    adminApi.updateSettings({ markup_rules: markupRules, quick_percents: quickPercents })
      .then(() => {
        toast.success('Налаштування ціноутворення збережено')
      })
      .catch(() => toast.error('Помилка збереження'))
      .finally(() => setSaving(false))
  }

  // --- Markup Rules Handlers ---
  function addMarkupRule() {
    setMarkupRules([...markupRules, { minPrice: 0, maxPrice: 99999, markupPct: 30 }])
  }

  function applyDefaultTemplate() {
    setMarkupRules([
      { minPrice: 0, maxPrice: 10, markupPct: 200 },
      { minPrice: 10, maxPrice: 20, markupPct: 150 },
      { minPrice: 20, maxPrice: 30, markupPct: 100 },
      { minPrice: 30, maxPrice: 40, markupPct: 80 },
      { minPrice: 40, maxPrice: 50, markupPct: 70 },
      { minPrice: 50, maxPrice: 60, markupPct: 60 },
      { minPrice: 60, maxPrice: 70, markupPct: 50 },
      { minPrice: 70, maxPrice: 80, markupPct: 45 },
      { minPrice: 80, maxPrice: 90, markupPct: 40 },
      { minPrice: 90, maxPrice: 100, markupPct: 35 },
      { minPrice: 100, maxPrice: 999999, markupPct: 30 }
    ])
  }

  function updateRule(index: number, field: keyof MarkupRule, value: string) {
    const val = parseFloat(value) || 0
    const newRules = [...markupRules]
    newRules[index][field] = val
    setMarkupRules(newRules)
  }

  function deleteRule(index: number) {
    setMarkupRules(markupRules.filter((_, i) => i !== index))
  }

  // --- Quick Percents Handlers ---
  function updateQuickPercent(index: number, value: string) {
    const val = parseFloat(value) || 0
    const newPercents = [...quickPercents]
    newPercents[index] = val
    setQuickPercents(newPercents)
  }

  function addQuickPercent() {
    if (quickPercents.length >= 10) {
      toast.warning('Максимум 10 швидких відсотків')
      return
    }
    setQuickPercents([...quickPercents, 0])
  }

  function deleteQuickPercent(index: number) {
    setQuickPercents(quickPercents.filter((_, i) => i !== index))
  }

  if (loading) {
    return <Layout title="Завантаження..."><div className="text-gray-400">Завантаження...</div></Layout>
  }

  return (
    <Layout
      title="Налаштування ціноутворення"
      actions={
        <Button onClick={handleSave} disabled={saving} icon={<Save size={16} />}>
          {saving ? 'Збереження...' : 'Зберегти зміни'}
        </Button>
      }
    >
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 max-w-6xl mx-auto">
        
        {/* Швидкі відсотки */}
        <Card className="flex flex-col h-full">
          <div className="p-5 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h2 className="font-bold text-gray-900 text-lg">Швидкі відсотки</h2>
              <p className="text-sm text-gray-500 mt-1">До 10 кнопок для швидкого застосування націнки</p>
            </div>
            <Button variant="secondary" onClick={addQuickPercent} disabled={quickPercents.length >= 10} icon={<Plus size={16} />}>
              Додати
            </Button>
          </div>
          <div className="p-5 flex-1">
            {quickPercents.length === 0 ? (
              <div className="text-center py-8 text-gray-400 bg-gray-50 rounded-xl border border-dashed border-gray-200">
                Немає налаштованих відсотків. Натисніть "Додати".
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {quickPercents.map((pct, i) => (
                  <div key={i} className="flex items-center gap-2 bg-gray-50 p-2 rounded-xl border border-gray-200">
                    <div className="flex-1 relative">
                      <Input
                        type="number"
                        min="0"
                        step="0.1"
                        value={pct || ''}
                        onChange={(e) => updateQuickPercent(i, e.target.value)}
                        className="pr-6 text-center font-bold text-lg"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 font-bold">%</span>
                    </div>
                    <button
                      onClick={() => deleteQuickPercent(i)}
                      className="text-gray-400 hover:text-red-500 transition-colors p-2 rounded-lg hover:bg-red-50"
                      title="Видалити"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        {/* Сітка цін */}
        <Card className="flex flex-col h-full">
          <div className="p-5 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="font-bold text-gray-900 text-lg">Сітка націнок</h2>
              <p className="text-sm text-gray-500 mt-1">Автоматична націнка залежно від закупівельної ціни</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button variant="secondary" size="sm" onClick={applyDefaultTemplate}>
                Шаблон 200%-30%
              </Button>
              <Button variant="secondary" size="sm" onClick={addMarkupRule} icon={<Plus size={16} />}>
                Додати
              </Button>
            </div>
          </div>
          <div className="p-0 flex-1 overflow-x-auto">
            {markupRules.length === 0 ? (
              <div className="m-5 text-center py-8 text-gray-400 bg-gray-50 rounded-xl border border-dashed border-gray-200">
                Сітка цін порожня. Натисніть "Додати діапазон".
              </div>
            ) : (
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
                  <tr>
                    <th className="px-5 py-4 font-medium rounded-tl-xl w-32">Від (грн)</th>
                    <th className="px-5 py-4 font-medium w-32">До (грн)</th>
                    <th className="px-5 py-4 font-medium w-32">Націнка (%)</th>
                    <th className="px-5 py-4 font-medium w-16 text-right rounded-tr-xl">Дії</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {markupRules.map((rule, i) => (
                    <tr key={i} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-5 py-3">
                        <Input
                          type="number"
                          min="0"
                          value={rule.minPrice === 0 && i === 0 ? 0 : (rule.minPrice || '')}
                          onChange={(e) => updateRule(i, 'minPrice', e.target.value)}
                          placeholder="0"
                          className="w-24 text-center"
                        />
                      </td>
                      <td className="px-5 py-3">
                        <Input
                          type="number"
                          min="0"
                          value={rule.maxPrice || ''}
                          onChange={(e) => updateRule(i, 'maxPrice', e.target.value)}
                          placeholder="99999"
                          className="w-24 text-center"
                        />
                      </td>
                      <td className="px-5 py-3 relative">
                        <div className="relative w-24">
                          <Input
                            type="number"
                            min="0"
                            step="0.1"
                            value={rule.markupPct || ''}
                            onChange={(e) => updateRule(i, 'markupPct', e.target.value)}
                            placeholder="30"
                            className="w-full pr-6 text-center font-bold text-yellow-600"
                          />
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 font-bold text-xs">%</span>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <button
                          onClick={() => deleteRule(i)}
                          className="text-gray-400 hover:text-red-500 transition-colors p-2 rounded-lg hover:bg-red-50 inline-flex"
                        >
                          <Trash2 size={18} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

      </div>
    </Layout>
  )
}
