import { useEffect, useState, useCallback } from 'react'
import { BarChart, ResponsiveContainer, CartesianGrid } from 'recharts'
import { ChartBar as Bar, ChartTooltip as Tooltip, ChartXAxis as XAxis, ChartYAxis as YAxis } from '@/lib/rechartsCompat'
import { BarChart2, AlertTriangle, Users, TrendingUp, Trash2, DollarSign, Download, Wrench, ClipboardCopy } from 'lucide-react'
import * as XLSX from 'xlsx'
import { reportApi } from './reportApi'
import { REASON_LABEL } from '@/types/writeoff'
import type { WriteoffReason } from '@/types/writeoff'
import type { SalesPeriodReport, LowStockProduct, Debtor, SoldItem } from '@/types/report'
import { Layout } from '@/components/Layout'
import { Card, Table, Badge } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDate, formatDateTime } from '@/lib/utils'
import { businessDateKey } from '@/lib/businessDate'
import { useAuthStore } from '@/stores/authStore'
import { staffApi } from '@/features/staff/staffApi'
import type { TireServiceReportRow } from '@/features/staff/staffApi'

type Tab = 'today' | 'sold' | 'tire' | 'weekly' | 'period' | 'lowstock' | 'debtors' | 'writeoffs' | 'profit'

interface ProfitReport {
  from: string; to: string
  revenue: number; cogs: number; gross_margin: number
  expenses: number; net_profit: number
}

const PAYMENT_COLOR: Record<string, 'green' | 'blue' | 'red'> = {
  cash: 'green', card: 'blue', debt: 'red',
}
const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Готівка', card: 'Картка', transfer: 'Переказ', account: 'Рахунок клієнта', debt: 'Борг',
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

function dateKeyDaysAgo(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return businessDateKey(date)
}

export default function DailyReport() {
  const role = (useAuthStore((state) => state.session)?.user?.app_metadata?.role as string | undefined) ?? ''
  const canSeeFullReports = role === 'owner' || role === 'admin'
  const [tab, setTab]           = useState<Tab>(() => canSeeFullReports ? 'today' : 'sold')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [report, setReport]     = useState<SalesPeriodReport | null>(null)
  const [weekly, setWeekly]     = useState<WeekDay[]>([])
  const [lowStock, setLowStock] = useState<LowStockProduct[]>([])
  const [debtors, setDebtors]   = useState<Debtor[]>([])
  const [writeoffs, setWriteoffs] = useState<WriteoffSummary | null>(null)
  const [profit, setProfit]       = useState<ProfitReport | null>(null)
  const [loading, setLoading]   = useState(false)


  // Продані товари за період — один зведений список для дозамовлення.
  const todayKey = businessDateKey()
  const [soldItems, setSoldItems] = useState<SoldItem[]>([])
  const [soldFrom, setSoldFrom] = useState(todayKey)
  const [soldTo, setSoldTo] = useState(todayKey)
  const [soldLoading, setSoldLoading] = useState(false)
  const [tireDate, setTireDate] = useState(todayKey)
  const [tireRows, setTireRows] = useState<TireServiceReportRow[]>([])
  const [tireLoading, setTireLoading] = useState(false)

  useEffect(() => {
    if (tab !== 'sold' || !soldFrom || !soldTo || soldFrom > soldTo) return
    let cancelled = false
    setSoldLoading(true)
    reportApi.soldItems(soldFrom, soldTo)
      .then((r) => { if (!cancelled) setSoldItems(r.data ?? []) })
      .catch(() => {
        if (!cancelled) {
          setSoldItems([])
          toast.error('Не вдалося сформувати список проданих товарів')
        }
      })
      .finally(() => { if (!cancelled) setSoldLoading(false) })
    return () => { cancelled = true }
  }, [tab, soldFrom, soldTo])

  async function copySoldItems() {
    if (soldItems.length === 0) {
      toast.error('Немає товарів для копіювання')
      return
    }
    const text = soldItems.map((item, index) =>
      `${index + 1}. ${item.name} | арт. ${item.sku || '—'} | продано ${item.qty_net} ${item.unit} | залишок ${item.qty_on_hand} ${item.unit}`,
    ).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Список проданих товарів скопійовано')
    } catch {
      toast.error('Не вдалося скопіювати список')
    }
  }

  function printSoldItems() {
    const escapeHtml = (value: unknown) => String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const period = soldFrom === soldTo ? soldFrom : `${soldFrom} — ${soldTo}`
    const rows = soldItems.map((it, i) =>
      `<tr><td>${i + 1}</td><td>${escapeHtml(it.sku)}</td><td>${escapeHtml(it.barcode || '—')}</td>` +
      `<td>${escapeHtml(it.name)}</td><td style="text-align:right;font-weight:bold">${it.qty_net} ${escapeHtml(it.unit)}</td>` +
      `<td style="text-align:right">${it.qty_on_hand} ${escapeHtml(it.unit)}</td></tr>`).join('')
    const w = window.open('', '_blank', 'width=900,height=900')
    if (!w) return
    w.document.write(`<html><head><title>Продані товари ${period}</title><style>
      body{font-family:Arial,sans-serif;font-size:12px;padding:16px}
      table{width:100%;border-collapse:collapse}
      td,th{border:1px solid #ccc;padding:4px 6px;text-align:left}
      th{background:#f3f3f3}
    </style></head><body>
      <h3>Продані товари за ${period} — для дозамовлення</h3>
      <table><tr><th>#</th><th>Артикул</th><th>Штрихкод</th><th>Назва</th><th>Продано</th><th>Залишок</th></tr>${rows}</table>
    </body></html>`)
    w.document.close()
    w.focus()
    w.print()
  }

  const loadToday = useCallback(async () => {
    setLoading(true)
    try {
      const [{ data: summary }, { data: period }, { data: items }] = await Promise.all([
        reportApi.salesToday(),
        reportApi.salesPeriod(todayKey, todayKey),
        reportApi.soldItems(todayKey, todayKey).catch(() => ({ data: [] as SoldItem[] })),
      ])
      setReport({ ...summary, sales: period.sales })
      setSoldItems(items ?? [])
    } catch { toast.error('Помилка завантаження') } finally { setLoading(false) }
  }, [todayKey])

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
      const { data } = await reportApi.profit(from, to)
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

  const loadTireReport = useCallback(async () => {
    if (!canSeeFullReports) return
    setTireLoading(true)
    try {
      const { data } = await staffApi.tireServiceReport(tireDate)
      setTireRows(data ?? [])
    } catch {
      setTireRows([])
      toast.error('Не вдалося завантажити звіт шиномонтажу')
    } finally {
      setTireLoading(false)
    }
  }, [canSeeFullReports, tireDate])

  const exportToExcel = useCallback(() => {
    try {
      let dataToExport: any[] = []
      let fileName = 'zvit'

      if (tab === 'today') {
        if (!soldItems.length) {
          toast.error('Немає проданих товарів за сьогодні')
          return
        }
        dataToExport = soldItems.map((item) => ({
          'Назва товару': item.name,
          'Артикул': item.sku,
          'Продано': item.qty_net,
          'Одиниця': item.unit,
          'Сума (грн)': item.net_revenue / 100,
        }))
        fileName = 'sold_items_today'
      } else if (tab === 'period') {
        if (!report || !report.sales.length) {
          toast.error('Немає даних для експорту')
          return
        }
        dataToExport = report.sales.map((s) => ({
          'Номер чека': '#' + s.sale_number,
          'Метод оплати': PAYMENT_LABELS[s.payment_method] || s.payment_method,
          'Сума (грн)': s.total / 100,
          'Дата': formatDateTime(s.completed_at),
        }))
        fileName = 'sales_period'
      } else if (tab === 'weekly') {
        if (!weekly.length) {
          toast.error('Немає даних для експорту')
          return
        }
        dataToExport = weekly.map((d) => ({
          'Дата': formatDate(d.date),
          'Кількість продажів': d.sales,
          'Виручка (грн)': d.revenue / 100,
        }))
        fileName = 'weekly_sales'
      } else if (tab === 'sold') {
        if (!soldItems.length) {
          toast.error('Немає проданих товарів за вибраний період')
          return
        }
        dataToExport = soldItems.map((item) => ({
          'Артикул': item.sku,
          'Штрихкод': item.barcode || '',
          'Назва': item.name,
          'Чисто продано': item.qty_net,
          'Одиниця': item.unit,
          'Залишок зараз': item.qty_on_hand,
          'Полиця': item.storage_bin || '',
          'Чиста сума (грн)': item.net_revenue / 100,
        }))
        fileName = `sold_items_${soldFrom}_${soldTo}`
      } else if (tab === 'tire') {
        if (!tireRows.length) {
          toast.error('Немає даних шиномонтажу за вибраний день')
          return
        }
        dataToExport = tireRows.map((row) => ({
          'Працівник': row.employee_name,
          'Послуг': row.services_qty,
          'Виручка шиномонтажу (грн)': row.service_revenue / 100,
          'Процент (грн)': row.commission_earned / 100,
          'Денна ставка (грн)': row.daily_rate / 100,
          'Нараховано (грн)': row.earned / 100,
          'Виплачено (грн)': row.paid / 100,
          'Штраф (грн)': row.penalty / 100,
          'До виплати (грн)': row.due / 100,
        }))
        fileName = `tire_service_${tireDate}`
      } else if (tab === 'lowstock') {
        if (!lowStock.length) {
          toast.error('Немає даних для експорту')
          return
        }
        dataToExport = lowStock.map((p) => ({
          'Артикул': p.sku,
          'Назва': p.name,
          'Категорія': p.category?.name || '—',
          'Залишок': `${p.qty_on_hand} ${p.unit}`,
          'Мінімум': `${p.reorder_point} ${p.unit}`,
        }))
        fileName = 'low_stock'
      } else if (tab === 'debtors') {
        if (!debtors.length) {
          toast.error('Немає даних для експорту')
          return
        }
        dataToExport = debtors.map((d) => ({
          'Телефон': d.phone,
          'Ім\'я': d.full_name || '—',
          'Борг (грн)': d.debt_balance / 100,
        }))
        fileName = 'debtors'
      } else if (tab === 'writeoffs') {
        if (!writeoffs || !writeoffs.writeoffs.length) {
          toast.error('Немає даних для експорту')
          return
        }
        dataToExport = writeoffs.writeoffs.map((w) => {
          const cost = w.items.reduce((s, i) => s + i.cost_kopecks, 0)
          return {
            'Дата': formatDate(w.created_at),
            'Причина': REASON_LABEL[w.reason as WriteoffReason] || w.reason,
            'Кількість позицій': w.items.length,
            'Собівартість (грн)': cost / 100,
          }
        })
        fileName = 'writeoffs'
      } else if (tab === 'profit') {
        if (!profit) {
          toast.error('Немає даних для експорту')
          return
        }
        dataToExport = [
          { 'Показник': 'Виручка', 'Значення (грн)': profit.revenue / 100 },
          { 'Показник': 'Собівартість (COGS)', 'Значення (грн)': -profit.cogs / 100 },
          { 'Показник': 'Валовий прибуток', 'Значення (грн)': profit.gross_margin / 100 },
          { 'Показник': 'Операційні витрати', 'Значення (грн)': -profit.expenses / 100 },
          { 'Показник': 'Чистий прибуток', 'Значення (грн)': profit.net_profit / 100 },
        ]
        fileName = 'profit_loss'
      }

      const worksheet = XLSX.utils.json_to_sheet(dataToExport)
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Звіт')
      const exportName = tab === 'sold' ? `${fileName}.xlsx` : `${fileName}_${businessDateKey()}.xlsx`
      XLSX.writeFile(workbook, exportName)
      toast.success('Звіт успішно експортовано в Excel')
    } catch (err) {
      toast.error(`Помилка експорту: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [tab, report, weekly, lowStock, debtors, writeoffs, profit, soldItems, soldFrom, soldTo, tireRows, tireDate])

  useEffect(() => {
    if (tab === 'today')         loadToday()
    else if (tab === 'weekly')   loadWeekly()
    else if (tab === 'lowstock') loadLowStock()
    else if (tab === 'debtors')  loadDebtors()
    else if (tab === 'writeoffs') loadWriteoffs()
    else if (tab === 'profit')   loadProfit()
    else if (tab === 'tire')     loadTireReport()
  }, [tab, loadToday, loadWeekly, loadLowStock, loadDebtors, loadWriteoffs, loadProfit, loadTireReport])

  const TABS = [
    { id: 'today',    label: 'Сьогодні',   icon: <TrendingUp size={15} /> },
    { id: 'sold',     label: 'Продані товари', icon: <BarChart2 size={15} /> },
    { id: 'tire',     label: 'Шиномонтаж', icon: <Wrench size={15} /> },
    { id: 'weekly',   label: '7 днів',     icon: <BarChart2 size={15} /> },
    { id: 'period',   label: 'За період',  icon: <BarChart2 size={15} /> },
    { id: 'lowstock', label: 'Мало товару', icon: <AlertTriangle size={15} /> },
    { id: 'debtors',  label: 'Боржники',   icon: <Users size={15} /> },
    { id: 'writeoffs', label: 'Списання',  icon: <Trash2 size={15} /> },
    { id: 'profit',    label: 'P&L',        icon: <DollarSign size={15} /> },
  ].filter((item) => canSeeFullReports || item.id === 'sold')

  const weeklyTotal = weekly.reduce((s, d) => s + d.revenue, 0)
  const weeklySales = weekly.reduce((s, d) => s + d.sales, 0)
  const soldQty = soldItems.reduce((sum, item) => sum + Number(item.qty_net), 0)
  const soldRevenue = soldItems.reduce((sum, item) => sum + Number(item.net_revenue), 0)
  const tireTotals = tireRows.reduce((totals, row) => ({
    services: totals.services + Number(row.services_qty ?? 0),
    revenue: totals.revenue + Number(row.service_revenue ?? 0),
    earned: totals.earned + Number(row.earned ?? 0),
    due: totals.due + Number(row.due ?? 0),
  }), { services: 0, revenue: 0, earned: 0, due: 0 })

  const chartData = weekly.map((d) => ({
    name: formatDate(d.date).slice(0, 5),
    revenue: d.revenue,
    sales: d.sales,
  }))

  return (
    <Layout title="Звіти">
      <div className="flex justify-between items-center gap-2 mb-6 flex-wrap">
        <div className="flex gap-2 flex-wrap">
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

        <button onClick={exportToExcel}
          className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white font-medium px-4 py-2 rounded-lg text-sm transition-colors cursor-pointer">
          <Download size={15} />
          Експорт в Excel
        </button>
      </div>

      {/* Сьогодні */}
      {tab === 'today' && report && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-3">
            {[
              { label: 'Чеків', value: String(report.total_sales) },
              { label: 'Продано за чеками', value: formatMoney(report.total_revenue) },
              { label: 'Отримано грошей', value: formatMoney(report.payment_received_total) },
              { label: 'Продано одиниць', value: String(Number(soldQty.toFixed(3))) },
              { label: 'Готівка', value: formatMoney(report.by_method.cash) },
              { label: 'Картка', value: formatMoney(report.by_method.card) },
              { label: 'Переказ', value: formatMoney(report.by_method.transfer) },
              { label: 'З рахунку клієнта', value: formatMoney(report.by_method.account) },
            ].map(({ label, value }) => (
              <Card key={label}>
                <p className="text-xs text-gray-400 mb-1">{label}</p>
                <p className="text-xl font-bold text-gray-900">{value}</p>
              </Card>
            ))}
          </div>
          <p className="mb-4 text-xs text-gray-500">
            Продажі рахуються за датою закриття чека. Передоплати замовлень — за датою прийняття грошей.
            Тому «Продано» та «Отримано грошей» можуть відрізнятися, але кожна сума має окрему розшифровку.
          </p>

          <Card padding="none">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <div>
                <h3 className="font-bold text-gray-900">Продані товари за сьогодні</h3>
                <p className="text-xs text-gray-500">Один товар — один рядок, незалежно від кількості чеків</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-500">Сума товарів за день</p>
                <p className="text-lg font-bold text-gray-900">{formatMoney(soldRevenue)}</p>
              </div>
            </div>
            {soldItems.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400">Проданих товарів за сьогодні немає</div>
            ) : (
              <div className="max-h-[55vh] overflow-auto">
                <table className="w-full min-w-[620px] text-sm">
                  <thead className="sticky top-0 bg-gray-50 text-xs text-gray-500 shadow-sm">
                    <tr>
                      <th className="px-4 py-3 text-left">Назва товару</th>
                      <th className="px-2 py-3 text-left">Артикул</th>
                      <th className="px-2 py-3 text-right">Продано</th>
                      <th className="px-4 py-3 text-right">Сума</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {soldItems.map((item) => (
                      <tr key={item.product_id} className="hover:bg-gray-50">
                        <td className="px-4 py-2 font-medium text-gray-900">{item.name}</td>
                        <td className="px-2 py-2 font-mono text-xs text-gray-600">{item.sku || '—'}</td>
                        <td className="px-2 py-2 text-right font-bold">{item.qty_net} {item.unit}</td>
                        <td className="px-4 py-2 text-right font-semibold text-gray-900">{formatMoney(item.net_revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card padding="none" className="mt-4">
            <div className="border-b border-gray-100 px-4 py-3">
              <h3 className="font-semibold text-gray-800">Чеки за сьогодні</h3>
            </div>
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

      {/* Продані товари за вибраний період — список для дозамовлення */}
      {tab === 'sold' && (
        <>
          <Card className="mb-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Продані товари за період</h2>
                <p className="mt-1 text-sm text-gray-500">Однакові товари з усіх чеків зібрані в один рядок — готовий список для повторного замовлення.</p>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs font-medium text-gray-600">
                  Від
                  <input type="date" value={soldFrom} max={soldTo}
                    onChange={(e) => {
                      const value = e.target.value
                      setSoldFrom(value)
                      if (value > soldTo) setSoldTo(value)
                    }}
                    className="mt-1 block rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800" />
                </label>
                <label className="text-xs font-medium text-gray-600">
                  До
                  <input type="date" value={soldTo} min={soldFrom} max={todayKey}
                    onChange={(e) => {
                      const value = e.target.value
                      setSoldTo(value)
                      if (value < soldFrom) setSoldFrom(value)
                    }}
                    className="mt-1 block rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800" />
                </label>
                <button onClick={copySoldItems} disabled={soldItems.length === 0 || soldLoading}
                  className="flex h-[38px] items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40">
                  <ClipboardCopy size={14} /> Копіювати список
                </button>
                <button onClick={printSoldItems} disabled={soldItems.length === 0 || soldLoading}
                  className="h-[38px] rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40">
                  🖨 Друк
                </button>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {[
                { label: 'Сьогодні', days: 0 },
                { label: '2 дні', days: 1 },
                { label: '7 днів', days: 6 },
                { label: '30 днів', days: 29 },
              ].map(({ label, days }) => (
                <button key={label} onClick={() => { setSoldFrom(dateKeyDaysAgo(days)); setSoldTo(todayKey) }}
                  className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-yellow-400 hover:bg-yellow-50">
                  {label}
                </button>
              ))}
            </div>
          </Card>

          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card>
              <p className="text-xs text-gray-400">Товарних позицій</p>
              <p className="text-2xl font-bold text-gray-900">{soldItems.length}</p>
            </Card>
            <Card>
              <p className="text-xs text-gray-400">Чисто продано</p>
              <p className="text-2xl font-bold text-gray-900">{Number(soldQty.toFixed(3))}</p>
            </Card>
            <Card>
              <p className="text-xs text-gray-400">Чиста сума продажів</p>
              <p className="text-2xl font-bold text-gray-900">{formatMoney(soldRevenue)}</p>
            </Card>
          </div>

          <Card padding="none">
            {soldLoading ? (
              <div className="flex min-h-48 items-center justify-center text-sm text-gray-400">Формуємо список…</div>
            ) : soldItems.length === 0 ? (
              <div className="flex min-h-48 items-center justify-center px-4 text-center text-sm text-gray-400">
                За вибраний період проданих товарів немає
              </div>
            ) : (
              <div className="max-h-[65vh] overflow-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="sticky top-0 bg-gray-50 text-xs text-gray-500 shadow-sm">
                    <tr>
                      <th className="px-4 py-3 text-left">Артикул</th>
                      <th className="px-2 py-3 text-left">Штрихкод</th>
                      <th className="px-2 py-3 text-left">Назва</th>
                      <th className="px-2 py-3 text-left">Полиця</th>
                      <th className="px-2 py-3 text-right">Чисто продано</th>
                      <th className="px-2 py-3 text-right">Залишок</th>
                      <th className="px-4 py-3 text-right">Сума</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {soldItems.map((item) => (
                      <tr key={item.product_id} className={item.qty_on_hand <= 0 ? 'bg-red-50/60' : 'hover:bg-gray-50'}>
                        <td className="px-4 py-2 font-mono text-xs text-gray-600">{item.sku || '—'}</td>
                        <td className="px-2 py-2 font-mono text-xs text-gray-600">{item.barcode || '—'}</td>
                        <td className="px-2 py-2 font-medium text-gray-900">{item.name}</td>
                        <td className="px-2 py-2 text-gray-500">{item.storage_bin || '—'}</td>
                        <td className="px-2 py-2 text-right font-bold text-gray-900">{item.qty_net} {item.unit}</td>
                        <td className={`px-2 py-2 text-right font-semibold ${item.qty_on_hand <= 0 ? 'text-red-600' : 'text-gray-600'}`}>
                          {item.qty_on_hand} {item.unit}
                        </td>
                        <td className="px-4 py-2 text-right text-gray-600">{formatMoney(item.net_revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      {/* Шиномонтаж — каса та зарплата за день */}
      {tab === 'tire' && canSeeFullReports && (
        <>
          <Card className="mb-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Шиномонтаж за день</h2>
                <p className="mt-1 text-sm text-gray-500">Виручка за роботи та фактичний розрахунок зарплати кожного шиномонтажника.</p>
              </div>
              <label className="text-xs font-medium text-gray-600">
                Дата
                <input type="date" value={tireDate} max={todayKey} onChange={(event) => setTireDate(event.target.value)}
                  className="mt-1 block rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800" />
              </label>
            </div>
          </Card>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card><p className="text-xs text-gray-400">Виконано послуг</p><p className="text-2xl font-bold text-gray-900">{Number(tireTotals.services.toFixed(3))}</p></Card>
            <Card><p className="text-xs text-gray-400">Каса шиномонтажу</p><p className="text-2xl font-bold text-gray-900">{formatMoney(tireTotals.revenue)}</p></Card>
            <Card><p className="text-xs text-gray-400">Нараховано зарплати</p><p className="text-2xl font-bold text-gray-900">{formatMoney(tireTotals.earned)}</p></Card>
            <Card><p className="text-xs text-gray-400">Зараз до виплати</p><p className="text-2xl font-bold text-amber-700">{formatMoney(tireTotals.due)}</p></Card>
          </div>
          <Card padding="none">
            {tireLoading ? (
              <div className="flex min-h-40 items-center justify-center text-sm text-gray-400">Формуємо звіт…</div>
            ) : tireRows.length === 0 ? (
              <div className="flex min-h-40 items-center justify-center px-4 text-center text-sm text-gray-400">За цей день немає робіт шиномонтажу або активних шиномонтажників</div>
            ) : (
              <div className="overflow-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500"><tr>
                    <th className="px-4 py-3 text-left">Працівник</th><th className="px-2 py-3 text-right">Послуг</th>
                    <th className="px-2 py-3 text-right">Каса</th><th className="px-2 py-3 text-right">Процент</th>
                    <th className="px-2 py-3 text-right">Ставка</th><th className="px-2 py-3 text-right">Нараховано</th>
                    <th className="px-2 py-3 text-right">Виплачено</th><th className="px-4 py-3 text-right">До виплати</th>
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100">{tireRows.map((row) => (
                    <tr key={row.employee_id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-semibold text-gray-900">{row.employee_name}</td>
                      <td className="px-2 py-3 text-right">{Number(row.services_qty.toFixed(3))}</td>
                      <td className="px-2 py-3 text-right font-semibold">{formatMoney(row.service_revenue)}</td>
                      <td className="px-2 py-3 text-right">{formatMoney(row.commission_earned)}</td>
                      <td className="px-2 py-3 text-right">{formatMoney(row.daily_rate)}</td>
                      <td className="px-2 py-3 text-right font-semibold">{formatMoney(row.earned)}</td>
                      <td className="px-2 py-3 text-right text-gray-500">{formatMoney(row.paid)}</td>
                      <td className="px-4 py-3 text-right font-bold text-amber-700">{formatMoney(row.due)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
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
                  <YAxis tickFormatter={(v: number) => (v / 100).toFixed(0)} tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} width={48} />
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
