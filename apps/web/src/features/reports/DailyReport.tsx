import { useEffect, useState, useCallback } from 'react'
import { BarChart, ResponsiveContainer, CartesianGrid } from 'recharts'
import { ChartBar as Bar, ChartTooltip as Tooltip, ChartXAxis as XAxis, ChartYAxis as YAxis } from '@/lib/rechartsCompat'
import { BarChart2, AlertTriangle, Users, TrendingUp, Trash2, DollarSign, Download } from 'lucide-react'
import * as XLSX from 'xlsx'
import { reportApi } from './reportApi'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { REASON_LABEL } from '@/types/writeoff'
import type { WriteoffReason } from '@/types/writeoff'
import type { SalesPeriodReport, LowStockProduct, Debtor } from '@/types/report'
import { Layout } from '@/components/Layout'
import { Card, Table, Badge } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDate, formatDateTime } from '@/lib/utils'
import { businessDateKey } from '@/lib/businessDate'

type Tab = 'today' | 'sold' | 'weekly' | 'period' | 'lowstock' | 'debtors' | 'writeoffs' | 'profit'

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

function dateKeyDaysAgo(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return businessDateKey(date)
}

export default function DailyReport() {
  const offlineMode = useAuthStore((state) => state.offlineMode)
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

  // «Контроль дня» — метрики для власника (повернення, знижки, недостачі, мінуси)
  interface DailyControl {
    revenue: number; receipts: number; avg_receipt: number
    cash: number; card: number; transfer: number; debt_sales: number; discounts: number
    returns_count: number; returns_sum: number
    returns_reasons: Array<{ reason: string; count: number }>
    recon_diffs: Array<{ difference: number; comment: string | null }>
    negative_stock: number; no_price: number
  }
  const [control, setControl] = useState<DailyControl | null>(null)
  const [sendingTg, setSendingTg] = useState(false)

  // Продані товари за період — один зведений список для дозамовлення.
  interface SoldItem {
    product_id: string; sku: string; barcode: string | null; name: string; unit: string
    qty_sold: number; revenue: number; qty_on_hand: number; storage_bin: string | null
  }
  const todayKey = businessDateKey()
  const [soldItems, setSoldItems] = useState<SoldItem[]>([])
  const [soldFrom, setSoldFrom] = useState(todayKey)
  const [soldTo, setSoldTo] = useState(todayKey)
  const [soldLoading, setSoldLoading] = useState(false)

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

  function printSoldItems() {
    const escapeHtml = (value: unknown) => String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const period = soldFrom === soldTo ? soldFrom : `${soldFrom} — ${soldTo}`
    const rows = soldItems.map((it, i) =>
      `<tr><td>${i + 1}</td><td>${escapeHtml(it.sku)}</td><td>${escapeHtml(it.barcode || '—')}</td>` +
      `<td>${escapeHtml(it.name)}</td><td style="text-align:right;font-weight:bold">${it.qty_sold} ${escapeHtml(it.unit)}</td>` +
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
      const [{ data: summary }, { data: period }] = await Promise.all([
        reportApi.salesToday(),
        reportApi.salesPeriod(),
      ])
      setReport({ ...summary, sales: period.sales })
      reportApi.dailyControl()
        .then((r) => setControl(r.data)).catch(() => {})
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

  const exportToExcel = useCallback(() => {
    try {
      let dataToExport: any[] = []
      let fileName = 'zvit'

      if (tab === 'today' || tab === 'period') {
        if (!report || !report.sales.length) {
          toast.error('Немає даних для експорту')
          return
        }
        dataToExport = report.sales.map((s) => ({
          'Номер чека': `#${s.sale_number}`,
          'Метод оплати': PAYMENT_LABELS[s.payment_method] || s.payment_method,
          'Сума (грн)': s.total / 100,
          'Дата': formatDateTime(s.completed_at),
        }))
        fileName = `sales_${tab === 'today' ? 'today' : 'period'}`
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
          'Продано': item.qty_sold,
          'Одиниця': item.unit,
          'Залишок зараз': item.qty_on_hand,
          'Полиця': item.storage_bin || '',
          'Сума продажів (грн)': item.revenue / 100,
        }))
        fileName = `sold_items_${soldFrom}_${soldTo}`
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
  }, [tab, report, weekly, lowStock, debtors, writeoffs, profit, soldItems, soldFrom, soldTo])

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
    { id: 'sold',     label: 'Продані товари', icon: <BarChart2 size={15} /> },
    { id: 'weekly',   label: '7 днів',     icon: <BarChart2 size={15} /> },
    { id: 'period',   label: 'За період',  icon: <BarChart2 size={15} /> },
    { id: 'lowstock', label: 'Мало товару', icon: <AlertTriangle size={15} /> },
    { id: 'debtors',  label: 'Боржники',   icon: <Users size={15} /> },
    { id: 'writeoffs', label: 'Списання',  icon: <Trash2 size={15} /> },
    { id: 'profit',    label: 'P&L',        icon: <DollarSign size={15} /> },
  ] as const

  const weeklyTotal = weekly.reduce((s, d) => s + d.revenue, 0)
  const weeklySales = weekly.reduce((s, d) => s + d.sales, 0)
  const soldQty = soldItems.reduce((sum, item) => sum + Number(item.qty_sold), 0)
  const soldRevenue = soldItems.reduce((sum, item) => sum + Number(item.revenue), 0)

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

          {/* Контроль дня — очима власника */}
          {control && (
            <Card className="mb-4 border-yellow-200 bg-yellow-50/40">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-bold text-gray-800">🔎 Контроль дня</p>
                {!offlineMode && (
                <button
                  onClick={async () => {
                    setSendingTg(true)
                    try {
                      const r = await api.post<{ data: { sent: boolean } }>('/api/v1/reports/daily-control/send', {})
                      if (r.data.sent) toast.success('Звіт надіслано в Telegram')
                      else toast.warning('Не налаштовано Telegram chat ID власника (Налаштування)')
                    } catch { toast.error('Не вдалося надіслати') } finally { setSendingTg(false) }
                  }}
                  disabled={sendingTg}
                  className="text-xs px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 font-medium disabled:opacity-50"
                >
                  {sendingTg ? 'Надсилаю…' : '✈️ Надіслати в Telegram'}
                </button>
                )}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div>
                  <p className="text-xs text-gray-400">Повернення</p>
                  <p className={`font-bold ${control.returns_count > 0 ? 'text-red-600' : 'text-gray-900'}`}>
                    {control.returns_count} шт{control.returns_sum > 0 ? ' · ' + formatMoney(control.returns_sum) : ''}
                  </p>
                  {control.returns_reasons.slice(0, 3).map((r, i) => (
                    <p key={i} className="text-[11px] text-gray-500">• {r.reason} ×{r.count}</p>
                  ))}
                </div>
                <div>
                  <p className="text-xs text-gray-400">Знижки за день</p>
                  <p className={`font-bold ${control.discounts > 0 ? 'text-amber-600' : 'text-gray-900'}`}>{formatMoney(control.discounts)}</p>
                  {control.debt_sales > 0 && <p className="text-[11px] text-gray-500">в борг: {formatMoney(control.debt_sales)}</p>}
                </div>
                <div>
                  <p className="text-xs text-gray-400">Звірка каси</p>
                  {control.recon_diffs.length === 0
                    ? <p className="font-bold text-green-600">без розбіжностей</p>
                    : control.recon_diffs.map((d, i) => (
                        <p key={i} className="font-bold text-red-600">{d.difference > 0 ? '+' : ''}{formatMoney(d.difference)}</p>
                      ))}
                </div>
                <div>
                  <p className="text-xs text-gray-400">Каталог</p>
                  <p className={`font-bold ${control.negative_stock > 0 ? 'text-red-600' : 'text-gray-900'}`}>мінуси: {control.negative_stock}</p>
                  <p className={`text-[11px] ${control.no_price > 0 ? 'text-amber-600 font-semibold' : 'text-gray-500'}`}>без ціни: {control.no_price}</p>
                </div>
              </div>
            </Card>
          )}


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
              <p className="text-xs text-gray-400">Всього продано</p>
              <p className="text-2xl font-bold text-gray-900">{Number(soldQty.toFixed(3))}</p>
            </Card>
            <Card>
              <p className="text-xs text-gray-400">Сума продажів</p>
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
                      <th className="px-2 py-3 text-right">Продано</th>
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
                        <td className="px-2 py-2 text-right font-bold text-gray-900">{item.qty_sold} {item.unit}</td>
                        <td className={`px-2 py-2 text-right font-semibold ${item.qty_on_hand <= 0 ? 'text-red-600' : 'text-gray-600'}`}>
                          {item.qty_on_hand} {item.unit}
                        </td>
                        <td className="px-4 py-2 text-right text-gray-600">{formatMoney(item.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
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
