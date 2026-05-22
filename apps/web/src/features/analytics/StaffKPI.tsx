import { useState, useEffect, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Card } from '@/components/ui'
import { formatMoney } from '@/lib/utils'

interface KPIStaff {
  manager_id: string
  manager_name: string
  total_revenue: number
  receipt_count: number
  average_receipt: number
  total_discounts: number
  discount_pct: number
  returns_count: number
  returns_amount: number
}

type Period = 'month' | 'quarter'

export default function StaffKPI() {
  const [items, setItems] = useState<KPIStaff[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('month')

  const range = useMemo(() => {
    const now = new Date()
    const end = now.toISOString().split('T')[0]
    if (period === 'month') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      return { startDate: start.toISOString().split('T')[0], endDate: end }
    }
    const start = new Date(now.getFullYear(), now.getMonth() - 2, 1)
    return { startDate: start.toISOString().split('T')[0], endDate: end }
  }, [period])

  useEffect(() => {
    setLoading(true)
    api.get<{ data: KPIStaff[] }>(`/api/v1/analytics/staff-kpi?startDate=${range.startDate}&endDate=${range.endDate}`)
      .then((res) => setItems(res.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [range])

  return (
    <Layout title="KPI персоналу">
      <div className="max-w-5xl space-y-4">
        {/* Period */}
        <div className="flex gap-2">
          <button onClick={() => setPeriod('month')}
            className={`px-4 py-2 rounded-lg text-sm font-medium ${period === 'month' ? 'bg-yellow-400 text-black' : 'bg-white border border-gray-200 text-gray-600'}`}>
            Цей місяць
          </button>
          <button onClick={() => setPeriod('quarter')}
            className={`px-4 py-2 rounded-lg text-sm font-medium ${period === 'quarter' ? 'bg-yellow-400 text-black' : 'bg-white border border-gray-200 text-gray-600'}`}>
            3 місяці
          </button>
          <span className="text-sm text-gray-400 self-center ml-auto">{range.startDate} — {range.endDate}</span>
        </div>

        {/* Chart */}
        {items.length > 1 && (
          <Card>
            <h3 className="text-sm font-semibold text-gray-800 mb-4">Виторг по співробітниках</h3>
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={items} margin={{ top: 5, right: 5, left: -10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="manager_name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => (v / 100).toFixed(0)} />
                  <Tooltip formatter={(v: number) => [formatMoney(v), 'Виторг']} />
                  <Bar dataKey="total_revenue" fill="#3B82F6" radius={[4, 4, 0, 0]} maxBarSize={50} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        )}

        {/* Table */}
        <Card padding="none">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="text-xs text-gray-500 uppercase">
                <th className="text-left px-4 py-3">Співробітник</th>
                <th className="text-right px-3 py-3">Виторг</th>
                <th className="text-right px-3 py-3">Чеків</th>
                <th className="text-right px-3 py-3">Середній</th>
                <th className="text-right px-3 py-3">Знижки</th>
                <th className="text-right px-3 py-3">Повернення</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading ? (
                <tr><td colSpan={6} className="text-center text-gray-400 py-8">Завантаження...</td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={6} className="text-center text-gray-400 py-8">Немає даних</td></tr>
              ) : items.map((mgr) => {
                const discountTooHigh = mgr.discount_pct > 5
                return (
                  <tr key={mgr.manager_id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{mgr.manager_name}</td>
                    <td className="px-3 py-3 text-right font-semibold">{formatMoney(mgr.total_revenue)}</td>
                    <td className="px-3 py-3 text-right">{mgr.receipt_count}</td>
                    <td className="px-3 py-3 text-right">{formatMoney(mgr.average_receipt)}</td>
                    <td className={`px-3 py-3 text-right font-medium ${discountTooHigh ? 'text-red-600 bg-red-50' : 'text-gray-700'}`}>
                      {formatMoney(mgr.total_discounts)}
                      {discountTooHigh && <span className="block text-[10px] text-red-500">{mgr.discount_pct}% від виторгу</span>}
                    </td>
                    <td className="px-3 py-3 text-right text-gray-600">
                      {mgr.returns_count > 0 ? `${mgr.returns_count} / ${formatMoney(mgr.returns_amount)}` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      </div>
    </Layout>
  )
}
