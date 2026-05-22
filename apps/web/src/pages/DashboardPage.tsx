import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Zap, Package, Users, Truck, AlertTriangle, ClipboardList, Receipt, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { api } from '@/lib/api'
import { orderApi } from '@/features/orders/orderApi'
import { Layout } from '@/components/Layout'
import { Card, Button } from '@/components/ui'
import { formatMoney } from '@/lib/utils'

interface DailyData {
  date: string
  revenue: number
  profit: number
}

interface Analytics {
  total_revenue: number
  cogs: number
  gross_profit: number
  total_receipts: number
  average_receipt: number
  daily: DailyData[]
}

interface ForecastItem { month: string; projected: number }
interface Anomaly { type: string; message: string; severity: 'warning' | 'critical' }

type Period = 'today' | 'week' | 'month'

function getRange(period: Period): { startDate: string; endDate: string } {
  const now = new Date()
  const end = now.toISOString().split('T')[0]
  if (period === 'today') return { startDate: end, endDate: end }
  if (period === 'week') {
    const start = new Date(now); start.setDate(start.getDate() - 6)
    return { startDate: start.toISOString().split('T')[0], endDate: end }
  }
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  return { startDate: start.toISOString().split('T')[0], endDate: end }
}

const PERIOD_LABELS: Record<Period, string> = { today: 'Сьогодні', week: '7 днів', month: 'Цей місяць' }

export default function DashboardPage() {
  const navigate = useNavigate()
  const [period, setPeriod] = useState<Period>('month')
  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const [lowStock, setLowStock] = useState(0)
  const [totals, setTotals] = useState({ products: 0, customers: 0, suppliers: 0, openOrders: 0 })
  const [forecast, setForecast] = useState<{ data: ForecastItem[]; trend: string } | null>(null)
  const [anomalies, setAnomalies] = useState<Anomaly[]>([])
  const [loading, setLoading] = useState(true)

  const range = useMemo(() => getRange(period), [period])

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const [a, p, c, s, l, o] = await Promise.all([
          api.get<{ data: Analytics }>(`/api/v1/analytics/dashboard?startDate=${range.startDate}&endDate=${range.endDate}`),
          api.get<any>('/api/v1/products?per_page=1'),
          api.get<any>('/api/v1/customers?per_page=1'),
          api.get<any>('/api/v1/suppliers?per_page=1'),
          api.get<any>('/api/v1/reports/products/low-stock'),
          orderApi.list().catch(() => ({ data: [] })),
        ])
        setAnalytics(a.data)
        setLowStock(l.data?.length ?? 0)
        const openOrders = (o.data ?? []).filter((ord: any) => !['completed', 'canceled'].includes(ord.status)).length
        setTotals({
          products: p.pagination?.total ?? 0, customers: c.pagination?.total ?? 0,
          suppliers: s.pagination?.total ?? 0, openOrders,
        })

        // Завантаження прогнозу та аномалій (не блокують основне завантаження)
        api.get<{ data: ForecastItem[]; trend: string }>('/api/v1/analytics/forecast?months=3')
          .then((r) => setForecast(r))
          .catch(() => {})
        api.get<{ data: Anomaly[] }>('/api/v1/analytics/anomalies')
          .then((r) => setAnomalies(r.data ?? []))
          .catch(() => {})
      } catch { setAnalytics(null) }
      finally { setLoading(false) }
    }
    load()
  }, [range])

  const d = analytics

  return (
    <Layout title="Дашборд" actions={
      <Button icon={<Zap size={16} />} onClick={() => navigate('/pos')}>
        <span className="hidden sm:inline">Відкрити касу</span>
      </Button>
    }>
      {/* Period selector */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
          <button key={p} onClick={() => setPeriod(p)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              period === p ? 'bg-yellow-400 text-black' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
            }`}>
            {PERIOD_LABELS[p]}
          </button>
        ))}
        <span className="text-xs text-gray-400 self-center ml-auto hidden sm:block whitespace-nowrap">
          {range.startDate} — {range.endDate}
        </span>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 mb-6 md:mb-8">
        {[
          { label: 'Виторг',          value: d?.total_revenue  ?? 0, color: 'bg-emerald-50 border-emerald-200', iconColor: 'text-emerald-600', icon: Receipt },
          { label: 'Валовий прибуток', value: d?.gross_profit  ?? 0, color: 'bg-blue-50 border-blue-200',       iconColor: 'text-blue-600',    icon: TrendingUp },
          { label: 'Кількість чеків', value: d?.total_receipts ?? 0, color: 'bg-purple-50 border-purple-200',   iconColor: 'text-purple-600',  icon: ClipboardList },
          { label: 'Середній чек',    value: d?.average_receipt ?? 0, color: 'bg-amber-50 border-amber-200',   iconColor: 'text-amber-600',   icon: Receipt },
        ].map(({ label, value, color, iconColor, icon: Icon }) => (
          <div key={label} className={`${color} border rounded-2xl p-3 md:p-5 shadow-sm`}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] md:text-xs font-semibold text-gray-500 uppercase tracking-wider leading-tight">{label}</span>
              <Icon size={16} className={`${iconColor} shrink-0`} />
            </div>
            <div className="text-xl md:text-3xl font-bold text-gray-900 truncate">
              {loading ? <span className="text-gray-300">—</span> : formatMoney(value)}
            </div>
          </div>
        ))}
      </div>

      {/* Revenue Chart */}
      {d?.daily && d.daily.length > 0 && (
        <Card className="mb-6">
          <h3 className="text-sm font-semibold text-gray-800 mb-4">Виторг по днях</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.daily} margin={{ top: 5, right: 5, left: -10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(v: string) => v.slice(5)} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => (v / 100).toFixed(0)} />
                <Tooltip formatter={(v: number) => [formatMoney(v), 'Виторг']} />
                <Bar dataKey="revenue" fill="#FFD000" radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* Bottom row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4">
          {[
            { label: 'Товари', value: totals.products, icon: Package, href: '/products', color: 'text-blue-500' },
            { label: 'Клієнти', value: totals.customers, icon: Users, href: '/customers', color: 'text-purple-500' },
            { label: 'Постачальники', value: totals.suppliers, icon: Truck, href: '/suppliers', color: 'text-green-500' },
            { label: 'Замовлень', value: totals.openOrders, icon: ClipboardList, href: '/orders', color: 'text-orange-500' },
          ].map(({ label, value, icon: Icon, href, color }) => (
            <button key={label} onClick={() => navigate(href)}
              className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-left hover:border-yellow-300 hover:shadow-md transition-all group">
              <Icon size={22} className={`${color} mb-2`} />
              <div className="text-2xl font-bold text-gray-900">{loading ? '—' : value}</div>
              <div className="text-xs text-gray-500 mt-0.5">{label}</div>
            </button>
          ))}
        </div>

        {lowStock > 0 && (
          <Card className="border-orange-200 bg-orange-50 flex items-start gap-3">
            <AlertTriangle size={20} className="text-orange-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-orange-800 text-sm">{lowStock} товар{lowStock > 1 ? 'ів' : ''} з низьким залишком</p>
              <p className="text-orange-600 text-xs mt-0.5">Залишок нижче мінімального рівня</p>
              <Button variant="ghost" size="sm" className="text-orange-700 hover:bg-orange-100 mt-2 px-0"
                onClick={() => navigate('/products?low_stock=true')}>Переглянути →</Button>
            </div>
          </Card>
        )}
      </div>

      {/* Прогноз + Аномалії */}
      {(forecast || anomalies.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
          {/* Прогноз */}
          {forecast && forecast.data.length > 0 && (
            <Card>
              <div className="flex items-center gap-2 mb-3">
                {forecast.trend === 'up' ? <TrendingUp size={16} className="text-green-500" />
                  : forecast.trend === 'down' ? <TrendingDown size={16} className="text-red-500" />
                  : <Minus size={16} className="text-gray-400" />}
                <h3 className="text-sm font-semibold text-gray-800">Прогноз виручки</h3>
              </div>
              <div className="space-y-2">
                {forecast.data.map((f) => (
                  <div key={f.month} className="flex justify-between items-center text-sm">
                    <span className="text-gray-600">{f.month}</span>
                    <span className="font-semibold text-gray-900">{formatMoney(f.projected)} ₴</span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-3">Лінійна екстраполяція на основі 6 місяців</p>
            </Card>
          )}

          {/* Аномалії */}
          {anomalies.length > 0 && (
            <Card>
              <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
                <AlertTriangle size={16} className="text-orange-500" /> Увага
              </h3>
              <div className="space-y-2">
                {anomalies.map((a, i) => (
                  <div key={i} className={`flex items-start gap-2 p-2 rounded-lg text-sm ${
                    a.severity === 'critical' ? 'bg-red-50 text-red-700' : 'bg-orange-50 text-orange-700'
                  }`}>
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <span>{a.message}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </Layout>
  )
}
