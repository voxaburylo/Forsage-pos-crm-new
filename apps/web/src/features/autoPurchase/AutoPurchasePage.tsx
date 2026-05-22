import { useState, useEffect, useCallback } from 'react'
import { ShoppingBag, RefreshCw, Trash2, AlertTriangle } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button, Card } from '@/components/ui'
import { api } from '@/lib/api'
import { toast } from '@/components/ui/Toast'

interface Suggestion {
  product_id: string
  product_name: string
  sku: string
  qty_on_hand: number
  reorder_point: number
  suggest_qty: number
  supplier_id: string | null
  supplier_name: string | null
  rule_id: string
}

interface Rule {
  id: string
  product: { id: string; sku: string; name: string; qty_on_hand: number; reorder_point: number } | null
  supplier: { id: string; name: string } | null
  min_qty: number
  max_qty: number
  is_active: boolean
}

export default function AutoPurchasePage() {
  const [tab, setTab] = useState<'suggestions' | 'rules'>('suggestions')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)

  const loadSuggestions = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.get<{ data: Suggestion[] }>('/api/v1/auto-purchase/suggestions')
      setSuggestions(data ?? [])
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

  const loadRules = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.get<{ data: Rule[] }>('/api/v1/auto-purchase/rules')
      setRules(data ?? [])
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    if (tab === 'suggestions') loadSuggestions()
    else loadRules()
  }, [tab, loadSuggestions, loadRules])

  async function deleteRule(id: string) {
    if (!confirm('Видалити правило?')) return
    try {
      await api.delete(`/api/v1/auto-purchase/rules/${id}`)
      toast.success('Правило видалено')
      loadRules()
    } catch { toast.error('Помилка') }
  }

  return (
    <Layout title="Автозакупки">
      <div className="flex gap-2 mb-6">
        {(['suggestions', 'rules'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t ? 'bg-yellow-100 text-yellow-800 border border-yellow-300' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {t === 'suggestions' ? `Пропозиції${suggestions.length > 0 ? ` (${suggestions.length})` : ''}` : 'Правила'}
          </button>
        ))}
        <div className="flex-1" />
        <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />}
          onClick={tab === 'suggestions' ? loadSuggestions : loadRules}>
          Оновити
        </Button>
      </div>

      {loading ? (
        <div className="text-center py-16 text-gray-400 text-sm">Завантаження...</div>
      ) : tab === 'suggestions' ? (
        suggestions.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <ShoppingBag size={40} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">Всі товари в нормі або правила не налаштовані</p>
          </div>
        ) : (
          <div className="space-y-2">
            {suggestions.map((s) => (
              <Card key={s.product_id}>
                <div className="flex items-center gap-4">
                  <AlertTriangle size={18} className="text-orange-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{s.product_name}</p>
                    <p className="text-xs text-gray-500">
                      Артикул: {s.sku} &nbsp;·&nbsp;
                      Залишок: <span className="text-red-600 font-medium">{s.qty_on_hand}</span> &nbsp;·&nbsp;
                      Поріг: {s.reorder_point}
                      {s.supplier_name && <> &nbsp;·&nbsp; Постачальник: {s.supplier_name}</>}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-blue-600">+{s.suggest_qty} шт</p>
                    <p className="text-[11px] text-gray-400">рекомендовано</p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )
      ) : (
        rules.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <p className="text-sm">Немає правил. Додайте правило для товару щоб отримувати пропозиції закупки.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b">
                  <th className="pb-2 pr-4 font-medium">Товар</th>
                  <th className="pb-2 pr-4 font-medium">Постачальник</th>
                  <th className="pb-2 pr-4 font-medium">Мін / Макс</th>
                  <th className="pb-2 pr-4 font-medium">Статус</th>
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rules.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="py-2 pr-4">
                      <p className="font-medium text-gray-900">{r.product?.name ?? '—'}</p>
                      <p className="text-xs text-gray-400">{r.product?.sku}</p>
                    </td>
                    <td className="py-2 pr-4 text-gray-600">{r.supplier?.name ?? '—'}</td>
                    <td className="py-2 pr-4 text-gray-600">{r.min_qty} / {r.max_qty}</td>
                    <td className="py-2 pr-4">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${r.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                        {r.is_active ? 'Активне' : 'Вимкнено'}
                      </span>
                    </td>
                    <td className="py-2">
                      <button onClick={() => deleteRule(r.id)} className="text-gray-400 hover:text-red-600 p-1 rounded">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </Layout>
  )
}
