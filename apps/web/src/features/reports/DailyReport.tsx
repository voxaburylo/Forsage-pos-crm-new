import { useEffect, useState, useCallback } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { BarChart2, AlertTriangle, Users, TrendingUp, Trash2, DollarSign } from 'lucide-react'
import { reportApi } from './reportApi'
import { api } from '@/lib/api'
import { REASON_LABEL } from '@/types/writeoff'
import type { WriteoffReason } from '@/types/writeoff'
import type { SalesPeriodReport, LowStockProduct, Debtor } from '@/types/report'
import { Layout } from '@/components/Layout'
import { Card, Table, Badge } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDate, formatDateTime } from '@/lib/utils'

type Tab = 'today' | 'weekly' | 'period' | 'lowstock' | 'debtors' | 'writeoffs' | 'profit'

interface ProfitReport {
  from: string; to: string
  revenue: number; cogs: number; gross_margin: number
  expenses: number; net_profit: number
}

const PAYMENT_COLOR: Record<string, 'green' | 'blue' | 'red'> = {
  cash: 'green', card: 'blue', debt: 'red',
}
const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Готівка', card: 'Картка', debt: 'Борг',
}

interface WeekDay { date: string; revenue: number; sales: number }
interface WriteoffSummary {
  count: number
  total_cost: number
  writeoffs: Array<{
    id: string
    reason: string
    created_at: string
    items: Array<{ cost_kopecks: number }>
  }>
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 shadow-sm text-sm">
      <p className="text-gray-500 text-xs">{label}</p>
      <p className="font-bold text-gray-900">{formatMoney(payload[0].value)}</p>
    </div>
  )
}

export default function DailyReport() {
  const [tab, setTab]           = useState<Tab>('today')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [report, setReport]     = useState<SalesPeriodReport | null>(null)
  const [weekly, setWeekly]     = useState<WeekDay[]>([])
  const [lowStock, setLowStock] = useState<LowStockProduct[]>([])
  const [debtors, setDebtors]   = useState<Debtor[]>([])
  const [writeoffs, setWriteoffs] = useState<WriteoffSummary | null>(null)
  const [profit, setProfit]       = useState<ProfitReport | null>(null)
  const [loading, setLoading]   = useState(false)

  const loadToday = useCallback(async () => {
    setLoading(true)
    try {
      const [{ data: summary }, { data: period }] = await Promise.all([
        reportApi.salesToday(),
        reportApi.salesPeriod(),
      ])
      setReport({ ...summary, sales: period.sales })
    } catch { toast.error('Помилка завантаження') } finally { setLoading(false) }
  }, [])

  const loadWeekly = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await reportApi.weekly()
      setWeekly(data)
    } catch { toast.error('Помилка завантаження') } finally { setLoading(false) }
  }, [])

  const loadPeriod = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await reportApi.salesPeriod(dateFrom || undefined, dateTo || undefined)
      setReport(data)
    } catch { toast.error('Помилка завантаження') } finally { setLoading(false) }
  }, [dateFrom, dateTo])

  const loadProfit = useCallback(async () => {
    setLoading(true)
    try {
      const now = new Date()
      const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
      const to   = now.toISOString()
      const { data } = await api.get<{ data: ProfitReport }>(`/api/v1/reports/profit?from=${from}&to=${to}`)
      setProfit(data)
    } catch { toast.error('Помилка завантаження') } finally { setLoading(false) }
  }, [])

  const loadLowStock = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await reportApi.lowStock()
      setLowStock(data)
    } catch { toast.error('Помилка завантаження') } finally { setLoading(false) }
  }, [])

  const loadDebtors = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await reportApi.debtors()
      setDebtors(data)
    } catch { toast.error('Помилка завантаження') } finally { setLoading(false) }
  }, [])

  const loadWriteoffs = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await reportApi.writeoffsSummary()
      setWriteoffs(data)
    } catch { toast.error('Помилка завантаження') } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    if (tab === 'today')         loadToday()
    else if (tab === 'weekly')   loadWeekly()
    else if (tab === 'lowstock') loadLowStock()
    else if (tab === 'debtors')  loadDebtors()
    else if (tab === 'writeoffs') loadWriteoffs()
    else if (tab === 'profit')   loadProfit()
  }, [tab, loadToday, loadWeekly, loadLowStock, loadDebtors, loadWriteoffs, loadProfit])

  const TABS = [
    { id: 'today',    label: 'Сьогодні',   icon: <TrendingUp size={15} /> },
    { id: 'weekly',   label: '7 днів',     icon: <BarChart2 size={15} /> },
    { id: 'period',   label: 'За період',  icon: <BarChart2 size={15} /> },
    { id: 'lowstock', label: 'Мало товару', icon: <AlertTriangle size={15} /> },
    { id: 'debtors',  label: 'Боржники',   icon: <Users size={15} /> },
    { id: 'writeoffs', label: 'Списання',  icon: <Trash2 size={15} /> },
    { id: 'profit',    label: 'P&L',        icon: <DollarSign size={15} /> },
  ] as const

  const weeklyTotal = weekly.reduce((s, d) => s + d.revenue, 0)
  const weeklySales = weekly.reduce((s, d) => s + d.sales, 0)

  const chartData = weekly.map((d) => ({
    name: formatDate(d.date).slice(0, 5),
    revenue: d.revenue,
    sales: d.sales,
  }))

  return (
    <Layout title="Звіти">
      <div className="flex gap-2 mb-6 flex-wrap">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id as Tab)}
            className={
              'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ' +
              (tab === t.id
                ? 'bg-yellow-400 text-black'
                : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300')
            }>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {/* Сьогодні */}
      {tab === 'today' && report && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            {[
              { label: 'Продажів',  value: String(report.total_sales) },
              { label: 'Виручка',   value: formatMoney(report.total_revenue) },
              { label: 'Готівка',   value: formatMoney(report.by_method.cash) },
              { label: 'Картка',    value: formatMoney(report.by_method.card) },
            ].map(({ label, value }) => (
              <Card key={label}>
                <p className="text-xs text-gray-400 mb-1">{label}</p>
                <p className="text-xl font-bold text-gray-900">{value}</p>
              </Card>
            ))}
          </div>
          <Card padding="none">
            <Table
              columns={[
                { key: 'num',   header: 'Чек',    render: (s) => <span className="font-mono text-xs">#{s.sale_number}</span> },
                { key: 'cust',  header: 'Клієнт', render: (s) => <span className="text-gray-600 text-sm">{s.customer?.full_name ?? s.customer?.phone ?? '—'}</span> },
                { key: 'pay',   header: 'Оплата', render: (s) => <Badge color={PAYMENT_COLOR[s.payment_method] ?? 'gray'}>{PAYMENT_LABELS[s.payment_method]}</Badge> },
                { key: 'total', header: 'Сума', className: 'text-right', render: (s) => <span className="font-semibold">{formatMoney(s.total)}</span> },
                { key: 'date',  header: 'Час', className: 'hidden md:table-cell text-right', render: (s) => <span className="text-gray-400 text-xs">{formatDateTime(s.completed_at)}</span> },
              ]}
              data={report.sales}
              keyFn={(s) => s.id}
              loading={loading}
              empty={<p className="text-gray-400 text-sm">Продажів немає</p>}
            />
          </Card>
        </>
      )}

      {/* 7 днів — графік */}
      {tab === 'weekly' && (
        <>
          <div className="grid grid-cols-2 gap-4 mb-6">
            <Card>
              <p className="text-xs text-gray-400 mb-1">Виручка за 7 днів</p>
              <p className="text-2xl font-bold text-gray-900">{formatMoney(weeklyTotal)}</p>
            </Card>
            <Card>
              <p className="text-xs text-gray-400 mb-1">Продажів за 7 днів</p>
              <p className="text-2xl font-bold text-gray-900">{weeklySales}</p>
            </Card>
          </div>

          <Card>
            <p className="text-sm font-semibold text-gray-700 mb-4">Виручка по днях</p>
            {loading ? (
              <div className="h-48 flex items-center justify-center text-gray-400 text-sm">Завантаження...</div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={(v) => (v / 100).toFixed(0)} tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} width={48} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="revenue" fill="#FFD000" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>

          <Card padding="none" className="mt-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 uppercase border-b border-gray-100">
                  <th className="text-left px-4 py-2">Дата</th>
                  <th className="text-right px-4 py-2">Продажів</th>
                  <th className="text-right px-4 py-2">Виручка</th>
                </tr>
              </thead>
              <tbody>
                {weekly.map((d) => (
                  <tr key={d.date} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="px-4 py-2">{formatDate(d.date)}</td>
                    <td className="px-4 py-2 text-right">{d.sales}</td>
                    <td className="px-4 py-2 text-right font-mono font-medium">{formatMoney(d.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {/* За період */}
      {tab === 'period' && (
        <>
          <Card className="mb-4">
            <div className="flex items-end gap-4 flex-wrap">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Від</label>
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">До</label>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400" />
              </div>
              <button onClick={loadPeriod}
                className="bg-yellow-400 hover:bg-yellow-500 text-black font-semibold px-4 py-2 rounded-lg text-sm transition-colors">
                Показати
              </button>
            </div>
          </Card>

          {report && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                {[
                  { label: 'Продажів', value: String(report.total_sales) },
                  { label: 'Виручка',  value: formatMoney(report.total_revenue) },
                  { label: 'Готівка',  value: formatMoney(report.by_method.cash) },
                  { label: 'Картка',   value: formatMoney(report.by_method.card) },
                ].map(({ label, value }) => (
                  <Card key={label}>
                    <p className="text-xs text-gray-400 mb-1">{label}</p>
                    <p className="text-xl font-bold">{value}</p>
                  </Card>
                ))}
              </div>
              <Card padding="none">
                <Table
                  columns={[
                    { key: 'num',   header: 'Чек',    render: (s) => <span className="font-mono text-xs">#{s.sale_number}</span> },
                    { key: 'pay',   header: 'Оплата', render: (s) => <Badge color={PAYMENT_COLOR[s.payment_method] ?? 'gray'}>{PAYMENT_LABELS[s.payment_method]}</Badge> },
                    { key: 'total', header: 'Сума', className: 'text-right', render: (s) => <span className="font-semibold">{formatMoney(s.total)}</span> },
                    { key: 'date',  header: 'Дата', className: 'text-right', render: (s) => <span className="text-gray-400 text-xs">{formatDateTime(s.completed_at)}</span> },
                  ]}
                  data={report.sales}
                  keyFn={(s) => s.id}
                  loading={loading}
                  empty={<p className="text-gray-400 text-sm">Продажів немає</p>}
                />
              </Card>
            </>
          )}
        </>
      )}

      {/* Мало товару */}
      {tab === 'lowstock' && (
        <Card padding="none">
          <Table
            columns={[
              { key: 'sku',  header: 'Артикул', render: (p) => <span className="font-mono text-xs text-gray-600">{p.sku}</span> },
              { key: 'name', header: 'Назва',   render: (p) => <div><p className="font-medium">{p.name}</p><p className="text-xs text-gray-400">{p.category?.name}</p></div> },
              { key: 'qty',  header: 'Залишок', className: 'text-right', render: (p) => (
                <span className={p.qty_on_hand <= 0 ? 'text-red-600 font-bold' : 'text-orange-600 font-bold'}>
                  {p.qty_on_hand} {p.unit}
                </span>
              )},
              { key: 'min',  header: 'Мінімум', className: 'text-right', render: (p) => <span className="text-gray-400">{p.reorder_point} {p.unit}</span> },
            ]}
            data={lowStock}
            keyFn={(p) => p.id}
            loading={loading}
            empty={<p className="text-green-600 text-sm text-center">Всі товари в нормі</p>}
          />
        </Card>
      )}

      {/* Боржники */}
      {tab === 'debtors' && (
        <Card padding="none">
          <Table
            columns={[
              { key: 'phone', header: 'Телефон', render: (d) => <span className="font-mono">{d.phone}</span> },
              { key: 'name',  header: "Ім'я",    render: (d) => <span>{d.full_name ?? '—'}</span> },
              { key: 'debt',  header: 'Борг', className: 'text-right', render: (d) => (
                <span className="font-bold text-red-600">{formatMoney(d.debt_balance)}</span>
              )},
            ]}
            data={debtors}
            keyFn={(d) => d.id}
            loading={loading}
            empty={<p className="text-green-600 text-sm text-center">Боржників немає</p>}
          />
        </Card>
      )}

      {/* Списання */}
      {tab === 'writeoffs' && writeoffs && (
        <>
          <div className="grid grid-cols-2 gap-4 mb-6">
            <Card>
              <p className="text-xs text-gray-400 mb-1">Актів цього місяця</p>
              <p className="text-2xl font-bold text-gray-900">{writeoffs.count}</p>
            </Card>
            <Card>
              <p className="text-xs text-gray-400 mb-1">Собівартість списань</p>
              <p className="text-2xl font-bold text-red-600">{formatMoney(writeoffs.total_cost)}</p>
            </Card>
          </div>

          <Card padding="none">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 uppercase border-b border-gray-100">
                  <th className="text-left px-4 py-2">Дата</th>
                  <th className="text-left px-4 py-2">Причина</th>
                  <th className="text-right px-4 py-2">Позицій</th>
                  <th className="text-right px-4 py-2">Собівартість</th>
                </tr>
              </thead>
              <tbody>
                {writeoffs.writeoffs.map((w) => {
                  const cost = w.items.reduce((s, i) => s + i.cost_kopecks, 0)
                  return (
                    <tr key={w.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="px-4 py-2">{formatDate(w.created_at)}</td>
                      <td className="px-4 py-2 text-gray-600">{REASON_LABEL[w.reason as WriteoffReason] ?? w.reason}</td>
                      <td className="px-4 py-2 text-right">{w.items.length}</td>
                      <td className="px-4 py-2 text-right font-mono text-red-600">{formatMoney(cost)}</td>
                    </tr>
                  )
                })}
                {writeoffs.writeoffs.length === 0 && (
                  <tr><td colSpan={4} className="text-center text-gray-400 text-sm py-8">Списань цього місяця немає</td></tr>
                )}
              </tbody>
            </table>
          </Card>
        </>
      )}
      {/* P&L Звіт */}
      {tab === 'profit' && (
        profit ? (
          <div className="space-y-4 max-w-xl">
            {[
              { label: 'Виручка', value: profit.revenue, color: 'text-blue-600' },
              { label: 'Собівартість (COGS)', value: profit.cogs, color: 'text-gray-700', negative: true },
              { label: 'Валовий прибуток', value: profit.gross_margin, color: profit.gross_margin >= 0 ? 'text-green-600' : 'text-red-600', border: true },
              { label: 'Операційні витрати', value: profit.expenses, color: 'text-gray-700', negative: true },
              { label: 'Чистий прибуток', value: profit.net_profit, color: profit.net_profit >= 0 ? 'text-green-700' : 'text-red-700', bold: true, border: true },
            ].map(({ label, value, color, negative, bold, border }) => (
              <div key={label} className={`flex justify-between items-center py-3 ${border ? 'border-t border-gray-200 mt-2' : ''}`}>
                <span className={`text-sm ${bold ? 'font-semibold text-gray-900' : 'text-gray-600'}`}>{label}</span>
                <span className={`text-lg font-bold ${color}`}>
                  {negative ? '−' : ''}{formatMoney(Math.abs(value))} ₴
                </span>
              </div>
            ))}
            <p className="text-xs text-gray-400 pt-2">Період: поточний місяць. COGS враховується лише для продажів через process_sale_v2.</p>
          </div>
        ) : (
          <div className="text-center py-16 text-gray-400 text-sm">Завантаження...</div>
        )
      )}
    </Layout>
  )
}
