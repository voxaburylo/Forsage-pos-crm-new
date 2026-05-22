import { useState, useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Card, Badge, Table } from '@/components/ui'
import { kopecksToHryvnia } from '@/types/product'

interface ABCItem {
  id: string
  sku: string
  name: string
  currentStock: number
  soldQty: number
  profit: number
  abc_class: string
  cumulative_pct: number
}

const CLASS_COLORS: Record<string, 'green' | 'yellow' | 'orange' | 'red'> = {
  A: 'green', B: 'yellow', C: 'orange', Z: 'red',
}
const CLASS_LABELS: Record<string, string> = {
  A: 'A (80%)', B: 'B (15%)', C: 'C (5%)', Z: 'Z (Мертвий)',
}

export default function ABCAnalysis() {
  const [items, setItems] = useState<ABCItem[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string | null>(null)
  const [showDeficit, setShowDeficit] = useState(false)

  useEffect(() => {
    api.get<{ data: ABCItem[] }>('/api/v1/analytics/abc?days=90')
      .then((res) => setItems(res.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const filtered = items.filter((item) => {
    if (showDeficit) return item.abc_class === 'A' && item.currentStock <= 0
    if (filter) return item.abc_class === filter
    return true
  })

  const deficitCount = items.filter((i) => i.abc_class === 'A' && i.currentStock <= 0).length

  const columns = [
    { key: 'class', header: 'Клас', className: 'w-16', render: (i: ABCItem) => (
      <Badge color={CLASS_COLORS[i.abc_class] ?? 'gray'}>{i.abc_class}</Badge>
    )},
    { key: 'sku', header: 'Артикул', className: 'w-28', render: (i: ABCItem) => (
      <span className="font-mono text-xs text-gray-600">{i.sku}</span>
    )},
    { key: 'name', header: 'Товар', render: (i: ABCItem) => (
      <div>
        <span className="font-medium text-gray-900">{i.name}</span>
        <span className="text-xs text-gray-400 ml-2">Stock: {i.currentStock}</span>
      </div>
    )},
    { key: 'sold', header: 'Продано', className: 'w-24 text-right', render: (i: ABCItem) => (
      <span className="font-medium">{i.soldQty} шт</span>
    )},
    { key: 'profit', header: 'Прибуток', className: 'w-28 text-right', render: (i: ABCItem) => (
      <span className="font-semibold text-green-700">{kopecksToHryvnia(i.profit)} ₴</span>
    )},
  ]

  return (
    <Layout title="ABC-аналіз товарів">
      <div className="max-w-5xl space-y-4">
        {/* Кнопка дефіциту */}
        {deficitCount > 0 && (
          <button onClick={() => setShowDeficit(!showDeficit)}
            className={`w-full flex items-center gap-3 px-5 py-3 rounded-xl border-2 transition-all ${
              showDeficit
                ? 'bg-red-50 border-red-400 text-red-800'
                : 'bg-red-50/50 border-red-200 text-red-700 hover:bg-red-50 hover:border-red-300'
            }`}>
            <AlertTriangle size={20} className="shrink-0" />
            <div className="text-left">
              <p className="font-bold text-sm">🚨 Дефіцит Класу А — {deficitCount} товар{deficitCount > 1 ? 'ів' : ''}</p>
              <p className="text-xs opacity-80">Найприбутковіші товари відсутні на складі! Терміново дозамовити.</p>
            </div>
            {showDeficit && <span className="ml-auto text-sm font-medium">× Закрити</span>}
          </button>
        )}

        {/* Фільтри */}
        <div className="flex gap-2 flex-wrap">
          {['A', 'B', 'C', 'Z'].map((cls) => (
            <button key={cls} onClick={() => { setFilter(filter === cls ? null : cls); setShowDeficit(false) }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                filter === cls ? 'bg-yellow-400 text-black' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>
              {CLASS_LABELS[cls] ?? cls}
            </button>
          ))}
          <span className="text-xs text-gray-400 self-center ml-auto">
            {items.length} товарів · {filtered.length} показано
          </span>
        </div>

        {/* Таблиця */}
        <Card padding="none">
          <Table
            columns={columns}
            data={filtered}
            keyFn={(i) => i.id}
            loading={loading}
            empty={<p className="text-gray-400 text-sm py-12 text-center">Немає даних</p>}
          />
        </Card>
      </div>
    </Layout>
  )
}
