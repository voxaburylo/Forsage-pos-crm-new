import { useState, useMemo } from 'react'
import { parseStaffRows, staffDateRange, staffExportRows, validStaffRange } from './staffData'
import { useReportRows } from './useReportRows'
import { ReportError } from './ReportError'
import { AnalyticsLayout as Layout } from '@/features/analytics/AnalyticsLayout'
import { Card } from '@/components/ui'
import { formatMoney } from '@/lib/utils'
import { TrendingUp, DollarSign, Users, Award, Calendar, Download } from 'lucide-react'
import * as XLSX from 'xlsx'
import { toast } from '@/components/ui/Toast'



type Period = 'month' | 'quarter' | 'year'

export default function StaffAnalytics() {
  const [period, setPeriod] = useState<Period>('month')
  const [customRange, setCustomRange] = useState({ startDate: '', endDate: '' })
  const [isCustom, setIsCustom] = useState(false)

  const range = useMemo(() => {
    const fallback = staffDateRange(isCustom ? 'month' : period)
    return isCustom ? { startDate: customRange.startDate || fallback.startDate,
      endDate: customRange.endDate || fallback.endDate } : fallback
  }, [period, isCustom, customRange])

  const { rows: items, loading, error, retry } = useReportRows(
    `/api/v1/analytics/staff-profitability?startDate=${range.startDate}&endDate=${range.endDate}`,
    validStaffRange(range.startDate, range.endDate), parseStaffRows,
  )

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



  const exportToExcel = () => {
    if (loading || error) return
    try {
      if (items.length === 0) {
        toast.error('Немає даних для експорту')
        return
      }

      const dataToExport = staffExportRows(items)

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
      <div className="max-w-7xl min-w-0 space-y-6">
        {/* Controls */}
        <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
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
            <div className="analytics-date-range flex items-center gap-2 animate-fade-in">
              <input
                type="date"
                aria-label="Дата початку"
                value={customRange.startDate}
                onChange={(e) => setCustomRange((prev) => ({ ...prev, startDate: e.target.value }))}
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
              />
              <span className="text-gray-400 text-sm">по</span>
              <input
                type="date"
                aria-label="Дата завершення"
                value={customRange.endDate}
                onChange={(e) => setCustomRange((prev) => ({ ...prev, endDate: e.target.value }))}
                className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
              />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-4 text-sm text-gray-500 font-medium">
            <div className="flex items-center gap-2">
              <Calendar size={16} className="text-gray-400" />
              <span>{range.startDate} — {range.endDate}</span>
            </div>
            <button
              onClick={exportToExcel}
              className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-semibold hover:bg-emerald-700 transition-colors shadow-sm"
              disabled={loading || Boolean(error) || items.length === 0}
            >
              <Download size={14} />
              Експорт в Excel
            </button>
          </div>
        </div>

        {/* Metric Cards Grid */}
        <ReportError message={error} retry={retry} />
        {loading && <p role="status">Завантаження звіту…</p>}
        {!loading && !error && <>
        <p className="text-sm text-gray-600">
          Продажі — за датою закриття чека, повернення — за датою повернення та початковим продавцем.
          Видані замовлення враховано один раз. Зарплата й виплати — за вибрані дні роботи.
          Результат = валовий прибуток − нарахування + утримання; виплата не віднімається вдруге.
          Інші витрати магазину тут не враховано.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="p-5 border border-gray-100 shadow-sm bg-gradient-to-br from-white to-gray-50/50">
            <div className="flex justify-between items-start">
              <p className="text-xs text-gray-600 font-semibold">Виручка після повернень</p>
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
              <p className="text-xs text-gray-600 font-semibold">Виплачено за дні роботи</p>
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
                Після нарахувань
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
                  <th className="text-right px-4 py-4 font-semibold">Виплачено / нараховано</th>
                  <th className="text-right px-6 py-4 font-semibold">Після нарахувань</th>
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
                      <td data-label="Співробітник" className="px-6 py-4">
                        <div className="font-semibold text-gray-900">{mgr.manager_name}</div>
                        <div className="text-[10px] text-gray-400 font-mono mt-0.5">{mgr.manager_id.slice(0, 8)}</div>
                      </td>
                      
                      <td data-label="Виручка (POS / Замовлення)" className="px-4 py-4 text-right">
                        <div className="font-semibold text-gray-800">{formatMoney(mgr.total_revenue)}</div>
                        <div className="text-xs text-gray-400">
                          {formatMoney(mgr.sales_revenue)} / {formatMoney(mgr.orders_revenue)}
                        </div>
                      </td>
                      
                      <td data-label="Собівартість (COGS)" className="px-4 py-4 text-right text-gray-600 font-medium">
                        {formatMoney(mgr.total_cogs)}
                      </td>
                      
                      <td data-label="Валовий прибуток" className="px-4 py-4 text-right">
                        <div className={`font-semibold ${hasGrossProfit ? 'text-teal-600' : 'text-red-500'}`}>
                          {formatMoney(mgr.gross_profit)}
                        </div>
                        {mgr.total_revenue > 0 && (
                          <div className="text-[10px] text-gray-400">
                            Маржа: {Math.round((mgr.gross_profit / mgr.total_revenue) * 100)}%
                          </div>
                        )}
                      </td>
                      
                      <td data-label="Виплачено / нараховано" className="px-4 py-4 text-right">
                        <div className="font-semibold text-rose-600">{formatMoney(mgr.total_payouts)}</div>
                        <div className="text-xs text-gray-400">
                          Нараховано: {formatMoney(mgr.salary_cost + mgr.bonus_cost - mgr.penalty_cost)}
                        </div>
                      </td>
                      
                      <td data-label="Після нарахувань" className="px-6 py-4 text-right">
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
        </>}
      </div>
    </Layout>
  )
}
