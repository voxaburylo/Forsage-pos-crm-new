import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ClipboardList, Receipt, TrendingUp } from 'lucide-react'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Card, Button } from '@/components/ui'
import { formatMoney } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { desktopBridge } from '@/lib/desktopBridge'
import { businessDateKey, businessDateRangeUtc } from '@/lib/businessDate'
import { staffApi } from '@/features/staff/staffApi'
import type { TireServiceReportRow } from '@/features/staff/staffApi'

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
  low_stock?: number
  totals?: { products: number; customers: number; suppliers: number; openOrders: number }
  overdue_count?: number
  debt?: { count: number; total: number }
  inventory?: { purchase_value: number; retail_value: number }
}

type Period = 'today' | 'week' | 'month' | 'date'
type QuickPeriod = Exclude<Period, 'date'>

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
  const [period, setPeriod] = useState<Period>('today')
  const [selectedDate, setSelectedDate] = useState(() => businessDateKey(new Date()))
  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const [lowStock, setLowStock] = useState(0)
  const [overdueCount, setOverdueCount] = useState(0)
  const [debt, setDebt] = useState({ count: 0, total: 0 })
  const [loading, setLoading] = useState(true)
  const loadSequenceRef = useRef(0)
  const [tireWorkers, setTireWorkers] = useState<TireServiceReportRow[]>([])

  const range = useMemo(() => getRange(period, selectedDate), [period, selectedDate])

  useEffect(() => {
    const requestId = ++loadSequenceRef.current
    let cancelled = false
    const isCurrent = () => !cancelled && requestId === loadSequenceRef.current
    async function load() {
      setLoading(true)
      setTireWorkers([])
      try {
        const desktop = desktopBridge()
        if (canSeeProfit && range.startDate === range.endDate) {
          void staffApi.tireServiceReport(range.startDate)
            .then(({ data }) => { if (isCurrent()) setTireWorkers(data ?? []) })
            .catch(() => { if (isCurrent()) setTireWorkers([]) })
        }
        if (desktop?.pos.dashboardSummary) {
          const saleDateRange = businessDateRangeUtc(range.startDate, range.endDate)
          const summary = await desktop.pos.dashboardSummary({
            date_from: saleDateRange.from,
            date_to: saleDateRange.to,
          })
          if (!isCurrent()) return
          setAnalytics({ ...summary.analytics, inventory: summary.inventory })
          setLowStock(Number(summary.low_stock ?? 0))
          setOverdueCount(Number(summary.overdue_count ?? 0))
          setDebt(summary.debt)
          return
        }
        if (desktop?.catalog.listProducts && desktop.pos.listCustomers && desktop.pos.listSales && desktop.orders?.list) {
          const [orders, lowResult, debtResult] = await Promise.all([
            desktop.orders.list({ offset: 0, limit: 500 }),
            desktop.catalog.listProducts({ lowStock: true, limit: 1, offset: 0 }),
            desktop.pos.listCustomers({ has_debt: 'true', sort: 'debt', page: 1, per_page: 200 }),
          ])

          const allSales: any[] = []
          let salesPage = 1
          let salesPages = 1
          const saleDateRange = businessDateRangeUtc(range.startDate, range.endDate)
          do {
            const response = await desktop.pos.listSales({ status: 'completed', date_from: saleDateRange.from, date_to: saleDateRange.to, page: salesPage, per_page: 200 })
            allSales.push(...(response.data ?? []))
            salesPages = response.pagination?.total_pages ?? 1
            salesPage++
          } while (salesPage <= salesPages)

          if (!isCurrent()) return
          const rangeSales = allSales.filter((sale) => {
            const key = businessDateKey(String(sale.completed_at ?? ''))
            return key >= range.startDate && key <= range.endDate
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
          const activeOrders = (orders ?? []).filter((order: any) => !['completed', 'canceled', 'cancelled', 'archived'].includes(order.status))
          setLowStock(Number(lowResult.total ?? 0))
          const nowTs = Date.now()
          setOverdueCount(activeOrders.filter((order: any) =>
            order.pickup_deadline_at && new Date(order.pickup_deadline_at).getTime() < nowTs).length)
          const debtList = debtResult.data ?? []
          setDebt({
            count: Number(debtResult.pagination?.total ?? debtList.length),
            total: debtList.reduce((sum: number, customer: any) => sum + Number(customer.debt_balance ?? 0), 0),
          })
          return
        }
        const response = await api.get<{ data: Analytics }>(
          `/api/v1/analytics/dashboard?startDate=${range.startDate}&endDate=${range.endDate}`,
        )
        if (!isCurrent()) return
        setAnalytics(response.data)
        setLowStock(Number(response.data.low_stock ?? 0))
        setOverdueCount(Number(response.data.overdue_count ?? 0))
        setDebt(response.data.debt ?? { count: 0, total: 0 })
      } catch {
        if (isCurrent()) setAnalytics(null)
      } finally {
        if (isCurrent()) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [range, canSeeProfit])

  const d = analytics
  const tireTotals = tireWorkers.reduce((sum, worker) => ({
    services_qty: sum.services_qty + Number(worker.services_qty ?? 0),
    service_revenue: sum.service_revenue + Number(worker.service_revenue ?? 0),
    due: sum.due + Number(worker.due ?? 0),
  }), { services_qty: 0, service_revenue: 0, due: 0 })

  return (
    <Layout title="Статистика">
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

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4 mb-6"><div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-4 shadow-sm"><div className="text-xs font-semibold text-indigo-700 uppercase tracking-wider">Товарів на складі</div><div className="mt-2 text-2xl font-bold text-indigo-950">{loading ? "—" : formatMoney(d?.inventory?.retail_value ?? 0)}</div><div className="text-xs text-indigo-700 mt-1">за ціною продажу</div></div><div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 shadow-sm"><div className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Собівартість залишків</div><div className="mt-2 text-2xl font-bold text-slate-900">{loading ? "—" : formatMoney(d?.inventory?.purchase_value ?? 0)}</div><div className="text-xs text-slate-600 mt-1">закупівельна вартість</div></div><div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 shadow-sm"><div className="text-xs font-semibold text-emerald-700 uppercase tracking-wider">Продано сьогодні</div><div className="mt-2 text-2xl font-bold text-emerald-950">{loading ? "—" : formatMoney(d?.daily?.find((item) => item.date === businessDateKey(new Date()))?.revenue ?? 0)}</div><div className="text-xs text-emerald-700 mt-1">за поточний день</div></div></div>

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

      {canSeeProfit && range.startDate === range.endDate && (
        <Card padding="none" className="mb-6">
          <div className="flex flex-col gap-2 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="font-bold text-gray-900">Шиномонтаж · {range.startDate}</h3>
              <p className="text-xs text-gray-500">Роботи й зарплата кожного працівника за день</p>
            </div>
            <div className="flex gap-4 text-sm">
              <span>Послуг: <strong>{tireTotals.services_qty}</strong></span>
              <span>Виручка: <strong>{formatMoney(tireTotals.service_revenue)}</strong></span>
              <span className="text-cyan-700">До виплати: <strong>{formatMoney(tireTotals.due)}</strong></span>
            </div>
          </div>
          {tireWorkers.length === 0 ? (
            <div className="px-4 py-7 text-center text-sm text-gray-400">
              Працівників шиномонтажу ще не налаштовано або за день немає нарахувань
            </div>
          ) : (
            <div className="overflow-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-4 py-3 text-left">Працівник</th>
                    <th className="px-2 py-3 text-right">Послуг</th>
                    <th className="px-2 py-3 text-right">Виручка</th>
                    <th className="px-2 py-3 text-right">Відсоток</th>
                    <th className="px-2 py-3 text-right">Нараховано</th>
                    <th className="px-2 py-3 text-right">Виплачено</th>
                    <th className="px-4 py-3 text-right">До виплати</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {tireWorkers.map((worker) => (
                    <tr key={worker.employee_id}>
                      <td className="px-4 py-3 font-semibold text-gray-900">{worker.employee_name}</td>
                      <td className="px-2 py-3 text-right">{worker.services_qty}</td>
                      <td className="px-2 py-3 text-right">{formatMoney(worker.service_revenue)}</td>
                      <td className="px-2 py-3 text-right">{formatMoney(worker.commission_earned)}</td>
                      <td className="px-2 py-3 text-right">{formatMoney(worker.earned)}</td>
                      <td className="px-2 py-3 text-right">{formatMoney(worker.paid)}</td>
                      <td className="px-4 py-3 text-right font-bold text-cyan-700">{formatMoney(worker.due)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      {/* Bottom row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

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

    </Layout>
  )
}
