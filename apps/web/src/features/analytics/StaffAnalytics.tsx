import { useState, useEffect, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Card, Badge } from '@/components/ui'
import { formatMoney, localDateKey } from '@/lib/utils'
import { TrendingUp, DollarSign, Users, Award, Calendar, AlertCircle, Download } from 'lucide-react'
import * as XLSX from 'xlsx'
import { toast } from '@/components/ui/Toast'

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

export default function StaffAnalytics() {
  const [items, setItems] = useState<StaffProfitabilityItem[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('month')
  const [customRange, setCustomRange] = useState({ startDate: '', endDate: '' })
  const [isCustom, setIsCustom] = useState(false)

  const range = useMemo(() => {
    if (isCustom) {
      return {
        startDate: customRange.startDate || localDateKey(new Date(new Date().getFullYear(), new Date().getMonth(), 1)),
        endDate: customRange.endDate || localDateKey()
      }
    }

    const now = new Date()
    const end = localDateKey(now)
    if (period === 'month') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      return { startDate: localDateKey(start), endDate: end }
    } else if (period === 'quarter') {
      const start = new Date(now.getFullYear(), now.getMonth() - 2, 1)
      return { startDate: localDateKey(start), endDate: end }
    } else {
      const start = new Date(now.getFullYear(), 0, 1)
      return { startDate: localDateKey(start), endDate: end }
    }
  }, [period, isCustom, customRange])

  useEffect(() => {
    setLoading(true)
    api.get<{ data: StaffProfitabilityItem[] }>(
      `/api/v1/analytics/staff-profitability?startDate=${range.startDate}&endDate=${range.endDate}`
    )
      .then((res) => setItems(res.data || []))
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

  // Find best seller by gross profit
  const bestSellerId = useMemo(() => {
    if (items.length === 0) return null
    const sorted = [...items].sort((a, b) => b.gross_profit - a.gross_profit)
    return sorted[0].gross_profit > 0 ? sorted[0].manager_id : null
  }, [items])

  // Recommendation builder
  const recommendations = useMemo(() => {
    return items.map((item) => {
      const profit = item.gross_profit / 100
      const isBest = item.manager_id === bestSellerId

      if (profit <= 0) {
        return {
          manager_id: item.manager_id,
          manager_name: item.manager_name,
          type: 'warning' as const,
          text: 'Активності або продажів за обраний період немає. Преміювання не рекомендовано.',
          amount: 0
        }
      }

      let bonus = 0
      let text = ''

      if (profit > 100000) {
        bonus = Math.round(profit * 0.05)
        text = `Чудовий показник валового прибутку (>100,000 грн). Рекомендована премія 5% від прибутку: ${bonus.toLocaleString()} ₴.`
      } else if (profit > 50000) {
        bonus = Math.round(profit * 0.03)
        text = `Гарний показник валового прибутку (>50,000 грн). Рекомендована премія 3% від прибутку: ${bonus.toLocaleString()} ₴.`
      } else if (profit > 20000) {
        bonus = 1000
        text = `Стабільні продажі (>20,000 грн прибутку). Рекомендовано преміювати фіксованим бонусом: 1,000 ₴.`
      } else {
        text = `Продажі нижче середнього (прибуток ${profit.toLocaleString()} ₴). Преміювання не рекомендовано, рекомендується навчання.`
      }

      if (isBest) {
        bonus += 1500
        text += ` Найкращий продавець за період! Додатковий бонус за 1-е місце: +1,500 ₴.`
      }

      return {
        manager_id: item.manager_id,
        manager_name: item.manager_name,
        type: bonus > 0 ? ('success' as const) : ('info' as const),
        text,
        amount: bonus
      }
    })
  }, [items, bestSellerId])

  const exportToExcel = () => {
    try {
      if (items.length === 0) {
        toast.error('Немає даних для експорту')
        return
      }

      const dataToExport = items.map((mgr) => ({
        'Співробітник': mgr.manager_name,
        'ID Співробітника': mgr.manager_id,
        'Виручка (Загальна), грн': mgr.total_revenue / 100,
        'Виручка POS, грн': mgr.sales_revenue / 100,
        'Виручка Замовлення, грн': mgr.orders_revenue / 100,
        'Собівартість (COGS), грн': mgr.total_cogs / 100,
        'Валовий прибуток, грн': mgr.gross_profit / 100,
        'Виплати (Загальні), грн': mgr.total_payouts / 100,
        'ЗП (Ставка), грн': mgr.salary_cost / 100,
        'Бонуси, грн': mgr.bonus_cost / 100,
        'Аванси/Штрафи, грн': (mgr.advance_cost - mgr.penalty_cost) / 100,
        'Чистий результат, грн': mgr.net_profit / 100,
      }))

      const ws = XLSX.utils.json_to_sheet(dataToExport)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Прибутковість працівників')
      
      const maxLens = Object.keys(dataToExport[0] || {}).map(key => {
        let maxVal = key.length
        dataToExport.forEach(row => {
          const val = String(row[key as keyof typeof row] || '')
          if (val.length > maxVal) maxVal = val.length
        })
        return { wch: maxVal + 3 }
      })
      ws['!cols'] = maxLens

      XLSX.writeFile(wb, `Staff_Analytics_${range.startDate}_to_${range.endDate}.xlsx`)
      toast.success('Дані успішно експортовано в Excel')
    } catch (error) {
      console.error(error)
      toast.error('Помилка при експорті в Excel')
    }
  }

  return (
    <Layout title="Аналітика персоналу">
      <div className="max-w-7xl space-y-6">
        {/* Controls */}
        <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setIsCustom(false); setPeriod('month') }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                !isCustom && period === 'month'
                  ? 'bg-yellow-500 text-black shadow-sm font-semibold'
                  : 'bg-gray-50 border border-gray-200 text-gray-600 hover:bg-gray-100'
              }`}
            >
              Цей місяць
            </button>
            <button
              onClick={() => { setIsCustom(false); setPeriod('quarter') }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                !isCustom && period === 'quarter'
                  ? 'bg-yellow-500 text-black shadow-sm font-semibold'
                  : 'bg-gray-50 border border-gray-200 text-gray-600 hover:bg-gray-100'
              }`}
            >
              3 місяці
            </button>
            <button
              onClick={() => { setIsCustom(false); setPeriod('year') }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                !isCustom && period === 'year'
                  ? 'bg-yellow-500 text-black shadow-sm font-semibold'
                  : 'bg-gray-50 border border-gray-200 text-gray-600 hover:bg-gray-100'
              }`}
            >
              Цей рік
            </button>
            <button
              onClick={() => setIsCustom(true)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                isCustom
                  ? 'bg-yellow-500 text-black shadow-sm font-semibold'
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
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
              />
              <span className="text-gray-400 text-sm">по</span>
              <input
                type="date"
                value={customRange.endDate}
                onChange={(e) => setCustomRange((prev) => ({ ...prev, endDate: e.target.value }))}
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
              />
            </div>
          )}

          <div className="flex items-center gap-4 text-sm text-gray-500 font-medium">
            <div className="flex items-center gap-2">
              <Calendar size={16} className="text-gray-400" />
              <span>{range.startDate} — {range.endDate}</span>
            </div>
            <button
              onClick={exportToExcel}
              className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-semibold hover:bg-emerald-700 transition-colors shadow-sm"
              disabled={loading || items.length === 0}
            >
              <Download size={14} />
              Експорт в Excel
            </button>
          </div>
        </div>

        {/* Metric Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="p-5 border border-gray-100 shadow-sm bg-gradient-to-br from-white to-gray-50/50">
            <div className="flex justify-between items-start">
              <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider">Виручка (Загальна)</p>
              <div className="p-1.5 bg-blue-500 text-white rounded-lg"><DollarSign size={16} /></div>
            </div>
            <h3 className="text-xl font-bold text-gray-900 mt-3">{formatMoney(summary.revenue)}</h3>
          </Card>

          <Card className="p-5 border border-gray-100 shadow-sm bg-gradient-to-br from-white to-gray-50/50">
            <div className="flex justify-between items-start">
              <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider">Валовий прибуток</p>
              <div className="p-1.5 bg-teal-500 text-white rounded-lg"><Award size={16} /></div>
            </div>
            <h3 className="text-xl font-bold text-teal-700 mt-3">{formatMoney(summary.grossProfit)}</h3>
          </Card>

          <Card className="p-5 border border-gray-100 shadow-sm bg-gradient-to-br from-white to-gray-50/50">
            <div className="flex justify-between items-start">
              <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider font-medium">Витрати на персонал</p>
              <div className="p-1.5 bg-rose-500 text-white rounded-lg"><Users size={16} /></div>
            </div>
            <h3 className="text-xl font-bold text-rose-900 mt-3">{formatMoney(summary.payouts)}</h3>
          </Card>

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
          <Card className="p-6 border border-gray-100 shadow-sm bg-white">
            <h3 className="text-base font-bold text-gray-800 mb-6">Порівняльний аналіз успішності працівників</h3>
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
                  <Bar dataKey="Валовий прибуток" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={40} />
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

        {/* Bonus Recommendations Panel */}
        {!loading && recommendations.length > 0 && (
          <Card className="p-6 border border-gray-100 shadow-sm bg-white">
            <h3 className="text-base font-bold text-gray-800 mb-4 flex items-center gap-2">
              <span>💡 Рекомендації та Преміювання</span>
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {recommendations.map((rec) => {
                const isWinner = rec.manager_id === bestSellerId
                return (
                  <div 
                    key={rec.manager_id}
                    className={`p-4 rounded-xl border flex flex-col justify-between transition-all ${
                      isWinner 
                        ? 'bg-yellow-50/40 border-yellow-200 shadow-sm'
                        : rec.type === 'success'
                        ? 'bg-green-50/20 border-green-100'
                        : rec.type === 'warning'
                        ? 'bg-red-50/10 border-red-100'
                        : 'bg-gray-50/50 border-gray-150'
                    }`}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div>
                        <div className="font-bold text-gray-900 flex items-center gap-1.5">
                          <span>{rec.manager_name}</span>
                          {isWinner && (
                            <Badge color="yellow" className="text-[9px] px-1.5 py-0.5 font-bold flex items-center gap-0.5">
                              🏆 Топ продажів
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-gray-600 mt-1.5 leading-relaxed">{rec.text}</p>
                      </div>
                      
                      {rec.amount > 0 && (
                        <div className="text-right shrink-0">
                          <span className="text-[10px] text-gray-400 font-semibold block">Рекомендована премія</span>
                          <span className="text-md font-extrabold text-green-600">+{rec.amount.toLocaleString()} ₴</span>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>
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
