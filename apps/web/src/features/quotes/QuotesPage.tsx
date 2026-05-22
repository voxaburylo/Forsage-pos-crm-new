import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Send, FileText, Car, User } from 'lucide-react'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Button, Badge, Card } from '@/components/ui'
import { formatDate, formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'

type BadgeColor = 'green' | 'orange' | 'red' | 'blue' | 'gray' | 'yellow'

interface Quote {
  id: string
  kp_number: string | null
  status: string
  total_amount: number
  comment: string | null
  source: string
  created_at: string
  sent_to_telegram_at: string | null
  vehicle_info: { make?: string; model?: string; year?: number; vin?: string } | null
  customer: { id: string; phone: string; full_name: string | null } | null
  items: Array<{ id: string; name: string; sell_price: number; variants: any[] }>
}

const STATUS_CONF: Record<string, { label: string; color: BadgeColor }> = {
  lead:        { label: 'Чернетка', color: 'blue' },
  new:         { label: 'Нове',     color: 'gray' },
  in_progress: { label: 'В роботі', color: 'yellow' },
  ready:       { label: 'Готово',   color: 'green' },
  completed:   { label: 'Видано',   color: 'green' },
  canceled:    { label: 'Скасовано', color: 'red' },
}

export default function QuotesPage() {
  const navigate = useNavigate()
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'lead' | 'all'>('lead')

  async function load() {
    setLoading(true)
    try {
      const url = filter === 'lead'
        ? '/api/v1/customer-orders?status=lead&per_page=100'
        : '/api/v1/customer-orders?per_page=100'
      const { data } = await api.get<{ data: Quote[] }>(url)
      setQuotes(data)
    } catch { toast.error('Помилка завантаження') }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [filter])

  const draftCount = quotes.filter((q) => q.status === 'lead').length

  return (
    <Layout
      title="Чернетки / КП"
      actions={
        <Button icon={<Plus size={16} />} onClick={() => navigate('/quotes/new')}>
          Нова чернетка
        </Button>
      }
    >
      <div className="max-w-4xl space-y-4">

        {/* Фільтр */}
        <div className="flex gap-2">
          {[
            { id: 'lead' as const, label: 'Чернетки', count: draftCount },
            { id: 'all' as const, label: 'Всі', count: quotes.length },
          ].map((f) => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                filter === f.id ? 'bg-yellow-400 text-black' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
              }`}>
              {f.label}
              <span className={`ml-1.5 text-[11px] px-1.5 py-0.5 rounded-full ${
                filter === f.id ? 'bg-black/20 text-black' : 'bg-gray-100 text-gray-500'
              }`}>{f.count}</span>
            </button>
          ))}
        </div>

        {/* Список */}
        {loading ? (
          <p className="text-center text-gray-400 text-sm py-12">Завантаження...</p>
        ) : quotes.length === 0 ? (
          <div className="text-center py-12">
            <FileText size={40} className="text-gray-200 mx-auto mb-3" />
            <p className="text-gray-400 text-sm">
              {filter === 'lead' ? 'Немає чернеток. Створіть нову.' : 'Немає замовлень'}
            </p>
            {filter === 'lead' && (
              <Button className="mt-4" icon={<Plus size={16} />} onClick={() => navigate('/quotes/new')}>
                Нова чернетка
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {quotes.map((q) => {
              const conf = STATUS_CONF[q.status] ?? { label: q.status, color: 'gray' as BadgeColor }
              const vehicle = q.vehicle_info
              const hasVariants = q.items.some((i) => i.variants?.length > 0)
              return (
                <Card
                  key={q.id}
                  onClick={() => navigate('/quotes/' + q.id)}
                  className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-blue-400"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      {/* Шапка */}
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <span className="font-bold text-gray-900 text-base">
                          {q.kp_number ?? `#${q.id.slice(0, 8)}`}
                        </span>
                        <Badge color={conf.color}>{conf.label}</Badge>
                        {hasVariants && (
                          <span className="text-[11px] bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full font-medium">
                            ⭐ Є варіанти
                          </span>
                        )}
                        {q.sent_to_telegram_at && (
                          <span className="text-[11px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium flex items-center gap-1">
                            <Send size={10} /> Відправлено TG
                          </span>
                        )}
                        <span className="text-xs text-gray-400">{formatDate(q.created_at)}</span>
                      </div>

                      {/* Клієнт */}
                      {q.customer && (
                        <p className="text-sm text-gray-700 flex items-center gap-1.5 mb-1">
                          <User size={13} className="text-gray-400" />
                          {q.customer.full_name ?? q.customer.phone}
                          {q.customer.full_name && <span className="text-gray-400 text-xs">{q.customer.phone}</span>}
                        </p>
                      )}

                      {/* Авто */}
                      {vehicle && (
                        <p className="text-xs text-gray-500 flex items-center gap-1.5 mb-1">
                          <Car size={12} />
                          {[vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(' ')}
                          {vehicle.vin && <span className="font-mono">{vehicle.vin}</span>}
                        </p>
                      )}

                      {/* Позиції */}
                      {q.items.length > 0 && (
                        <p className="text-xs text-gray-500 mt-1">
                          {q.items.slice(0, 3).map((i) => i.name).join(' · ')}
                          {q.items.length > 3 && ` · ще ${q.items.length - 3}...`}
                        </p>
                      )}

                      {q.comment && (
                        <p className="text-xs text-gray-400 mt-1 italic truncate">{q.comment}</p>
                      )}
                    </div>

                    <div className="text-right shrink-0">
                      <p className="font-bold text-gray-900">
                        {q.total_amount > 0 ? formatMoney(q.total_amount) : '—'}
                      </p>
                      <p className="text-xs text-gray-400">{q.items.length} поз.</p>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </Layout>
  )
}
