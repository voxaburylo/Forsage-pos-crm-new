import { useState, useEffect } from 'react'
import { Clock } from 'lucide-react'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Card, Badge } from '@/components/ui'
import { formatMoney, formatDate } from '@/lib/utils'

interface WaitlistEntry {
  id: string
  product_id: string
  customer_id: string
  status: 'waiting' | 'notified' | 'fulfilled'
  created_at: string
  notified_at: string | null
  product: { id: string; sku: string; name: string; retail_price: number; qty_on_hand: number }
  customer: { id: string; phone: string; full_name: string | null }
}

export default function WaitlistPage() {
  const [entries, setEntries] = useState<WaitlistEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get<{ data: WaitlistEntry[] }>('/api/v1/waitlist')
      .then((res) => setEntries(res.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <Layout title="Лист очікування">
      <div className="max-w-4xl">
        <div className="flex items-center gap-2 mb-4">
          <Clock size={16} className="text-gray-400" />
          <span className="text-sm text-gray-500">Активні очікування: {entries.filter((e) => e.status === 'waiting').length}</span>
        </div>

        <Card padding="none">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="text-xs text-gray-500 uppercase">
                <th className="text-left px-4 py-3">Клієнт</th>
                <th className="text-left px-4 py-3">Товар</th>
                <th className="text-right px-4 py-3">Ціна</th>
                <th className="text-right px-4 py-3">Залишок</th>
                <th className="text-center px-4 py-3">Статус</th>
                <th className="text-right px-4 py-3">Дата</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading ? (
                <tr><td colSpan={6} className="text-center text-gray-400 py-8">Завантаження...</td></tr>
              ) : entries.length === 0 ? (
                <tr><td colSpan={6} className="text-center text-gray-400 py-8">Немає очікувань</td></tr>
              ) : entries.map((e) => (
                <tr key={e.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{e.customer.full_name ?? e.customer.phone}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-800">{e.product.name}</div>
                    <div className="text-xs text-gray-400 font-mono">{e.product.sku}</div>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">{formatMoney(e.product.retail_price)}</td>
                  <td className="px-4 py-3 text-right">
                    {e.product.qty_on_hand > 0
                      ? <span className="text-green-600 font-medium">{e.product.qty_on_hand}</span>
                      : <span className="text-red-400">Нема</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Badge color={e.status === 'waiting' ? 'orange' : e.status === 'notified' ? 'green' : 'gray'}>
                      {e.status === 'waiting' ? 'Очікує' : e.status === 'notified' ? 'Сповіщено' : 'Виконано'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">{formatDate(e.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </Layout>
  )
}
