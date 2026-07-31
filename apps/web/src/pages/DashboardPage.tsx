import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Zap, Package, Users, Truck, AlertTriangle, ClipboardList, Receipt, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { api } from '@/lib/api'
import { orderApi } from '@/features/orders/orderApi'
import { Layout } from '@/components/Layout'
import { Card, Button } from '@/components/ui'
import { formatMoney } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { desktopBridge } from '@/lib/desktopBridge'

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

type Period = 'today' | 'week' | 'month' | 'date'
type QuickPeriod = Exclude<Period, 'date'>

const BUSINESS_DATE_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function businessDateKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return BUSINESS_DATE_FORMATTER.format(date)
}

function getRange(period: Period, selectedDate: string): { startDate: string; endDate: string } {
  if (period === 'date') return { startDate: selectedDate, endDate: selectedDate }
  const end = businessDateKey(new Date())
  if (period === 'today') return { startDate: end, endDate: end }
  if (period === 'week') {
    const start = new Date(`${end}T12:00:00.000Z`)
    start.setUTCDate(start.getUTCDate() - 6)
    return { startDate: start.toISOString().slice(0, 10), endDate: end }
  }
  return { startDate: `${end.slice(0, 8)}01`, endDate: end }
}

const PERIOD_LABELS: Record<QuickPeriod, string> = { today: 'Сьогодні', week: '7 днів', month: 'Цей місяць' }

export default function DashboardPage() {
  const navigate = useNavigate()
  // Прибуток — тільки власнику/адміну; менеджер бачить виторг і чеки
  const role = useAuthStore((s) => (s.session?.user?.app_metadata?.role as string) ?? 'cashier')
  const canSeeProfit = ['owner', 'admin'].includes(role)
  const [period, setPeriod] = useState<Period>('month')
  const [selectedDate, setSelectedDate] = useState(() => businessDateKey(new Date()))
  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const [lowStock, setLowStock] = useState(0)
  const [totals, setTotals] = useState({ products: 0, customers: 0, suppliers: 0, openOrders: 0 })
  const [forecast, setForecast] = useState<{ data: ForecastItem[]; trend: string } | null>(null)
  const [anomalies, setAnomalies] = useState<Anomaly[]>([])
  const [overdueCount, setOverdueCount] = useState(0)
  const [debt, setDebt] = useState({ count: 0, total: 0 })
  const [loading, setLoading] = useState(true)

  const range = useMemo(() => getRange(period, selectedDate), [period, selectedDate])

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const desktop = desktopBridge()
        if (desktop?.catalog.listProducts && desktop.pos.listCustomers && desktop.pos.listSales && desktop.orders?.list) {
          const [productResult, customerResult, supplierResult, orders] = await Promise.all([
            desktop.catalog.listProducts({ limit: 1, offset: 0 }),
            desktop.pos.listCustomers({ page: 1, per_page: 1 }),
            desktop.supply?.listSuppliers?.({ page: 1, per_page: 1 }) ?? Promise.resolve({ data: [], pagination: { total: 0 } }),
            desktop.orders.list({ offset: 0, limit: 500 }),
          ])
          const lowResult = await desktop.catalog.listProducts({ lowStock: true, limit: 1, offset: 0 })
          const debtResult = await desktop.pos.listCustomers({ has_debt: 'true', sort: 'debt', page: 1, per_page: 200 })

          const allSales: any[] = []
          let salesPage = 1
          let salesPages = 1
          do {
            const response = await desktop.pos.listSales({ page: salesPage, per_page: 200 })
            allSales.push(...(response.data ?? []))
            salesPages = response.pagination?.total_pages ?? 1
            salesPage++
          } while (salesPage <= salesPages)

          const rangeSales = allSales.filter((sale) => {
            const key = businessDateKey(String(sale.completed_at ?? ''))
            return sale.status === 'completed' && key >= range.startDate && key <= range.endDate
          })
          const totalRevenue = rangeSales.reduce((sum, sale) => sum + Number(sale.total ?? 0), 0)
          const cogs = rangeSales.reduce((sum, sale) => sum + (sale.sale_items ?? []).reduce(
            (itemSum: number, item: any) => itemSum + Number(item.purchase_price ?? 0) * Number(item.qty ?? 0),
            0,
          ), 0)
          const dailyMap = new Map<string, DailyData>()
          for (const sale of rangeSales) {
            const date = businessDateKey(String(sale.completed_at ?? ''))
            const current = dailyMap.get(date) ?? { date, revenue: 0, profit: 0 }
            const saleCogs = (sale.sale_items ?? []).reduce(
              (sum: number, item: any) => sum + Number(item.purchase_price ?? 0) * Number(item.qty ?? 0),
              0,
            )
            current.revenue += Number(sale.total ?? 0)
            current.profit += Number(sale.total ?? 0) - saleCogs
            dailyMap.set(date, current)
          }
          setAnalytics({
            total_revenue: totalRevenue,
            cogs,
            gross_profit: totalRevenue - cogs,
            total_receipts: rangeSales.length,
            average_receipt: rangeSales.length ? Math.round(totalRevenue / rangeSales.length) : 0,
            daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
          })
          const activeOrders = (orders ?? []).filter((order: any) => !['completed', 'canceled'].includes(order.status))
          setLowStock(Number(lowResult.total ?? 0))
          setTotals({
            products: Number(productResult.total ?? 0),
            customers: Number(customerResult.pagination?.total ?? 0),
            suppliers: Number(supplierResult.pagination?.total ?? supplierResult.data?.length ?? 0),
            openOrders: activeOrders.length,
          })
          const nowTs = Date.now()
          setOverdueCount(activeOrders.filter((order: any) =>
            order.pickup_deadline_at && new Date(order.pickup_deadline_at).getTime() < nowTs).length)
          const debtList = debtResult.data ?? []
          setDebt({
            count: Number(debtResult.pagination?.total ?? debtList.length),
            total: debtList.reduce((sum: number, customer: any) => sum + Number(customer.debt_balance ?? 0), 0),
          })
          setForecast(null)
          setAnomalies([])
          return
        }
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
        const activeOrders = (o.data ?? []).filter((ord: any) => !['completed', 'canceled'].includes(ord.status))
        setTotals({
          products: p.pagination?.total ?? 0, customers: c.pagination?.total ?? 0,
          suppliers: s.pagination?.total ?? 0, openOrders: activeOrders.length,
        })

        // Прострочені замовлення (дедлайн видачі минув)
        const nowTs = Date.now()
        setOverdueCount(activeOrders.filter((ord: any) =>
          ord.pickup_deadline_at && new Date(ord.pickup_deadline_at).getTime() < nowTs).length)

        // Борги клієнтів (кількість — з пагінації; сума — по завантаженій сторінці)
        api.get<{ data: Array<{ debt_balance: number }>; pagination?: { total: number } }>('/api/v1/customers?has_debt=true&per_page=100')
          .then((r) => {
            const list = r.data ?? []
            setDebt({
              count: r.pagination?.total ?? list.length,
              total: list.reduce((s2, x) => s2 + (x.debt_balance ?? 0), 0),
            })
          })
          .catch(() => {})

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
        {(Object.keys(PERIOD_LABELS) as QuickPeriod[]).map((p) => (
          <button key={p} onClick={() => setPeriod(p)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              period === p ? 'bg-yellow-400 text-black' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
            }`}>
            {PERIOD_LABELS[p]}
          </button>
        ))}
        <label className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium ${
          period === 'date' ? 'border-yellow-400 bg-yellow-50 text-black' : 'border-gray-200 bg-white text-gray-600'
        }`}>
          <span className="whitespace-nowrap">За день</span>
          <input
            type="date"
            aria-label="Дата продажів"
            value={selectedDate}
            max={businessDateKey(new Date())}
            onChange={(event) => {
              if (!event.target.value) return
              setSelectedDate(event.target.value)
              setPeriod('date')
            }}
            className="min-w-0 bg-transparent font-semibold text-gray-900 outline-none"
          />
        </label>
        <span className="text-xs text-gray-400 self-center ml-auto hidden sm:block whitespace-nowrap">
          {range.startDate} — {range.endDate}
        </span>
      </div>

      {period === 'date' && (
        <div className="mb-6 flex flex-col gap-1 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-sm font-semibold text-emerald-900">
            Загальна сума продажів за {new Date(`${selectedDate}T12:00:00`).toLocaleDateString('uk-UA')}
          </span>
          <strong className="text-2xl text-emerald-800">{loading ? '—' : formatMoney(d?.total_revenue ?? 0)}</strong>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 mb-6 md:mb-8">
        {[
          { label: period === 'date' ? 'Продажі за день' : 'Виторг', value: d?.total_revenue ?? 0, color: 'bg-emerald-50 border-emerald-200', iconColor: 'text-emerald-600', icon: Receipt },
          ...(canSeeProfit ? [{ label: 'Валовий прибуток', value: d?.gross_profit ?? 0, color: 'bg-blue-50 border-blue-200', iconColor: 'text-blue-600', icon: TrendingUp }] : []),
          { label: 'Кількість чеків', value: d?.total_receipts ?? 0, color: 'bg-purple-50 border-purple-200',   iconColor: 'text-purple-600',  icon: ClipboardList, raw: true },
          { label: 'Середній чек',    value: d?.average_receipt ?? 0, color: 'bg-amber-50 border-amber-200',   iconColor: 'text-amber-600',   icon: Receipt },
        ].map(({ label, value, color, iconColor, icon: Icon, raw }) => (
          <div key={label} className={`${color} border rounded-2xl p-3 md:p-5 shadow-sm`}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] md:text-xs font-semibold text-gray-500 uppercase tracking-wider leading-tight">{label}</span>
              <Icon size={16} className={`${iconColor} shrink-0`} />
            </div>
            <div className="text-xl md:text-3xl font-bold text-gray-900 truncate">
              {loading ? <span className="text-gray-300">—</span> : raw ? value.toLocaleString('uk-UA') : formatMoney(value)}
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

        {overdueCount > 0 && (
          <Card className="border-red-200 bg-red-50 flex items-start gap-3">
            <ClipboardList size={20} className="text-red-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-red-800 text-sm">{overdueCount} прострочен{overdueCount > 1 ? 'их' : 'е'} замовлен{overdueCount > 1 ? 'ь' : 'ня'}</p>
              <p className="text-red-600 text-xs mt-0.5">Минув дедлайн видачі</p>
              <Button variant="ghost" size="sm" className="text-red-700 hover:bg-red-100 mt-2 px-0"
                onClick={() => navigate('/needs-action')}>Переглянути →</Button>
            </div>
          </Card>
        )}

        {debt.count > 0 && (
          <Card className="border-amber-200 bg-amber-50 flex items-start gap-3">
            <Receipt size={20} className="text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-amber-800 text-sm">Борги клієнтів: {formatMoney(debt.total)}</p>
              <p className="text-amber-600 text-xs mt-0.5">{debt.count} клієнт{debt.count > 1 ? 'ів' : ''} із заборгованістю</p>
              <Button variant="ghost" size="sm" className="text-amber-700 hover:bg-amber-100 mt-2 px-0"
                onClick={() => navigate('/customers?has_debt=true')}>Переглянути →</Button>
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
                    <span className="font-semibold text-gray-900">{formatMoney(f.projected)}</span>
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
