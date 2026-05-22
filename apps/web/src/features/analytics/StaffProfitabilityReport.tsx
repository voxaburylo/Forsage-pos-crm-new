import { useState, useEffect, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Card } from '@/components/ui'
import { formatMoney } from '@/lib/utils'
import { TrendingUp, DollarSign, Users, Award, Calendar, AlertCircle } from 'lucide-react'

interface StaffProfitabilityItem {
  manager_id: string
  manager_name: string
  sales_revenue: number
  sales_cogs: number
  orders_revenue: number
  orders_cogs: number
  total_revenue: number
  total_cogs: number
  gross_profit: number
  salary_cost: number
  bonus_cost: number
  advance_cost: number
  penalty_cost: number
  total_payouts: number
  net_profit: number
}

type Period = 'month' | 'quarter' | 'year'

export default function StaffProfitabilityReport() {
  const [items, setItems] = useState<StaffProfitabilityItem[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('month')
  const [customRange, setCustomRange] = useState({ startDate: '', endDate: '' })
  const [isCustom, setIsCustom] = useState(false)

  const range = useMemo(() => {
    if (isCustom) {
      return {
        startDate: customRange.startDate || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
        endDate: customRange.endDate || new Date().toISOString().split('T')[0]
      }
    }

    const now = new Date()
    const end = now.toISOString().split('T')[0]
    if (period === 'month') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      return { startDate: start.toISOString().split('T')[0], endDate: end }
    } else if (period === 'quarter') {
      const start = new Date(now.getFullYear(), now.getMonth() - 2, 1)
      return { startDate: start.toISOString().split('T')[0], endDate: end }
    } else {
      const start = new Date(now.getFullYear(), 0, 1)
      return { startDate: start.toISOString().split('T')[0], endDate: end }
    }
  }, [period, isCustom, customRange])

  useEffect(() => {
    setLoading(true)
    api.get<{ data: StaffProfitabilityItem[] }>(
      `/api/v1/analytics/staff-profitability?startDate=${range.startDate}&endDate=${range.endDate}`
    )
      .then((res) => setItems(res.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [range])

  // Summary Metrics
  const summary = useMemo(() => {
    return items.reduce(
      (acc, curr) => {
        acc.revenue += curr.total_revenue
        acc.cogs += curr.total_cogs
        acc.grossProfit += curr.gross_profit
        acc.payouts += curr.total_payouts
        acc.netProfit += curr.net_profit
        return acc
      },
      { revenue: 0, cogs: 0, grossProfit: 0, payouts: 0, netProfit: 0 }
    )
  }, [items])

  // Chart Data preparation
  const chartData = useMemo(() => {
    return items.map((item) => ({
      name: item.manager_name,
      'Валовий прибуток': item.gross_profit,
      'Витрати на ЗП': item.total_payouts,
      'Чистий прибуток': item.net_profit,
    }))
  }, [items])

  return (
    <Layout title="Прибутковість працівників">
      <div className="max-w-7xl space-y-6">
        {/* Controls */}
        <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setIsCustom(false); setPeriod('month') }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                !isCustom && period === 'month'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-gray-50 border border-gray-200 text-gray-600 hover:bg-gray-100'
              }`}
            >
              Цей місяць
            </button>
            <button
              onClick={() => { setIsCustom(false); setPeriod('quarter') }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                !isCustom && period === 'quarter'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-gray-50 border border-gray-200 text-gray-600 hover:bg-gray-100'
              }`}
            >
              3 місяці
            </button>
            <button
              onClick={() => { setIsCustom(false); setPeriod('year') }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                !isCustom && period === 'year'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-gray-50 border border-gray-200 text-gray-600 hover:bg-gray-100'
              }`}
            >
              Цей рік
            </button>
            <button
              onClick={() => setIsCustom(true)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                isCustom
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-gray-50 border border-gray-200 text-gray-600 hover:bg-gray-100'
              }`}
            >
              Інший період
            </button>
          </div>

          {isCustom && (
            <div className="flex items-center gap-2 animate-fade-in">
              <input
                type="date"
                value={customRange.startDate}
                onChange={(e) => setCustomRange((prev) => ({ ...prev, startDate: e.target.value }))}
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <span className="text-gray-400 text-sm">по</span>
              <input
                type="date"
                value={customRange.endDate}
                onChange={(e) => setCustomRange((prev) => ({ ...prev, endDate: e.target.value }))}
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

          <div className="flex items-center gap-2 text-sm text-gray-500 font-medium">
            <Calendar size={16} className="text-gray-400" />
            <span>{range.startDate} — {range.endDate}</span>
          </div>
        </div>

        {/* Metric Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="bg-gradient-to-br from-blue-50 to-blue-100/50 p-5 rounded-2xl border border-blue-100/80 shadow-sm transition-transform hover:-translate-y-0.5 duration-200">
            <div className="flex justify-between items-start">
              <p className="text-xs font-semibold uppercase tracking-wider text-blue-600/80">Виручка (Загальна)</p>
              <div className="p-1.5 bg-blue-500 text-white rounded-lg"><DollarSign size={16} /></div>
            </div>
            <h3 className="text-xl font-bold text-blue-900 mt-3">{formatMoney(summary.revenue)}</h3>
          </div>

          <div className="bg-gradient-to-br from-orange-50 to-orange-100/50 p-5 rounded-2xl border border-orange-100/80 shadow-sm transition-transform hover:-translate-y-0.5 duration-200">
            <div className="flex justify-between items-start">
              <p className="text-xs font-semibold uppercase tracking-wider text-orange-600/80">Собівартість (COGS)</p>
              <div className="p-1.5 bg-orange-500 text-white rounded-lg"><TrendingUp size={16} /></div>
            </div>
            <h3 className="text-xl font-bold text-orange-900 mt-3">{formatMoney(summary.cogs)}</h3>
          </div>

          <div className="bg-gradient-to-br from-teal-50 to-teal-100/50 p-5 rounded-2xl border border-teal-100/80 shadow-sm transition-transform hover:-translate-y-0.5 duration-200">
            <div className="flex justify-between items-start">
              <p className="text-xs font-semibold uppercase tracking-wider text-teal-600/80">Валовий прибуток</p>
              <div className="p-1.5 bg-teal-500 text-white rounded-lg"><Award size={16} /></div>
            </div>
            <h3 className="text-xl font-bold text-teal-900 mt-3">{formatMoney(summary.grossProfit)}</h3>
          </div>

          <div className="bg-gradient-to-br from-rose-50 to-rose-100/50 p-5 rounded-2xl border border-rose-100/80 shadow-sm transition-transform hover:-translate-y-0.5 duration-200">
            <div className="flex justify-between items-start">
              <p className="text-xs font-semibold uppercase tracking-wider text-rose-600/80">Витрати на персонал</p>
              <div className="p-1.5 bg-rose-500 text-white rounded-lg"><Users size={16} /></div>
            </div>
            <h3 className="text-xl font-bold text-rose-900 mt-3">{formatMoney(summary.payouts)}</h3>
          </div>

          <div className={`bg-gradient-to-br p-5 rounded-2xl border shadow-sm transition-transform hover:-translate-y-0.5 duration-200 ${
            summary.netProfit >= 0
              ? 'from-emerald-50 to-emerald-100/50 border-emerald-100/80'
              : 'from-amber-50 to-amber-100/50 border-amber-100/80'
          }`}>
            <div className="flex justify-between items-start">
              <p className={`text-xs font-semibold uppercase tracking-wider ${summary.netProfit >= 0 ? 'text-emerald-600/80' : 'text-amber-600/80'}`}>
                Чистий прибуток
              </p>
              <div className={`p-1.5 text-white rounded-lg ${summary.netProfit >= 0 ? 'bg-emerald-500' : 'bg-amber-500'}`}>
                <TrendingUp size={16} />
              </div>
            </div>
            <h3 className={`text-xl font-bold mt-3 ${summary.netProfit >= 0 ? 'text-emerald-900' : 'text-amber-900'}`}>
              {formatMoney(summary.netProfit)}
            </h3>
          </div>
        </div>

        {/* Visual Chart */}
        {chartData.length > 0 ? (
          <Card className="p-6">
            <h3 className="text-base font-bold text-gray-800 mb-6">Порівняльний фінансовий аналіз працівників</h3>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#6b7280' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} tickFormatter={(v: number) => (v / 100).toFixed(0)} />
                  <Tooltip
                    formatter={(v: number) => [formatMoney(v), '']}
                    contentStyle={{ borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  />
                  <Legend verticalAlign="top" height={36} />
                  <Bar dataKey="Валовий прибуток" fill="#14b8a6" radius={[4, 4, 0, 0]} maxBarSize={40} />
                  <Bar dataKey="Витрати на ЗП" fill="#f43f5e" radius={[4, 4, 0, 0]} maxBarSize={40} />
                  <Bar dataKey="Чистий прибуток" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        ) : !loading && (
          <div className="bg-yellow-50 border border-yellow-100 text-yellow-800 p-4 rounded-xl flex items-center gap-2">
            <AlertCircle size={20} className="text-yellow-600" />
            <span>Немає активних продажів або замовлень для побудови графіку за вказаний період.</span>
          </div>
        )}

        {/* Details Table */}
        <Card padding="none" className="overflow-hidden border border-gray-100 shadow-sm rounded-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr className="text-xs text-gray-500 uppercase tracking-wider">
                  <th className="text-left px-6 py-4 font-semibold">Співробітник</th>
                  <th className="text-right px-4 py-4 font-semibold">Виручка (POS / Замовлення)</th>
                  <th className="text-right px-4 py-4 font-semibold">Собівартість (COGS)</th>
                  <th className="text-right px-4 py-4 font-semibold">Валовий прибуток</th>
                  <th className="text-right px-4 py-4 font-semibold">Виплати (ЗП / Бонуси / Інше)</th>
                  <th className="text-right px-6 py-4 font-semibold">Чистий результат</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="text-center text-gray-400 py-12">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                        <span>Завантаження даних...</span>
                      </div>
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center text-gray-400 py-12">Немає фінансових даних за обраний період</td>
                  </tr>
                ) : items.map((mgr) => {
                  const hasNetProfit = mgr.net_profit >= 0
                  const hasGrossProfit = mgr.gross_profit >= 0
                  
                  return (
                    <tr key={mgr.manager_id} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-6 py-4">
                        <div className="font-semibold text-gray-900">{mgr.manager_name}</div>
                        <div className="text-[10px] text-gray-400 font-mono mt-0.5">{mgr.manager_id.slice(0, 8)}</div>
                      </td>
                      
                      <td className="px-4 py-4 text-right">
                        <div className="font-semibold text-gray-800">{formatMoney(mgr.total_revenue)}</div>
                        <div className="text-xs text-gray-400">
                          {formatMoney(mgr.sales_revenue)} / {formatMoney(mgr.orders_revenue)}
                        </div>
                      </td>
                      
                      <td className="px-4 py-4 text-right text-gray-600 font-medium">
                        {formatMoney(mgr.total_cogs)}
                      </td>
                      
                      <td className="px-4 py-4 text-right">
                        <div className={`font-semibold ${hasGrossProfit ? 'text-teal-600' : 'text-red-500'}`}>
                          {formatMoney(mgr.gross_profit)}
                        </div>
                        {mgr.total_revenue > 0 && (
                          <div className="text-[10px] text-gray-400">
                            Маржа: {Math.round((mgr.gross_profit / mgr.total_revenue) * 100)}%
                          </div>
                        )}
                      </td>
                      
                      <td className="px-4 py-4 text-right">
                        <div className="font-semibold text-rose-600">{formatMoney(mgr.total_payouts)}</div>
                        <div className="text-xs text-gray-400">
                          {formatMoney(mgr.salary_cost)} / {formatMoney(mgr.bonus_cost)} / {formatMoney(mgr.advance_cost - mgr.penalty_cost)}
                        </div>
                      </td>
                      
                      <td className="px-6 py-4 text-right">
                        <span className={`inline-flex items-center px-3 py-1.5 rounded-full text-xs font-bold ${
                          hasNetProfit
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                            : 'bg-red-50 text-red-700 border border-red-100'
                        }`}>
                          {hasNetProfit ? '+' : ''}{formatMoney(mgr.net_profit)}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </Layout>
  )
}
