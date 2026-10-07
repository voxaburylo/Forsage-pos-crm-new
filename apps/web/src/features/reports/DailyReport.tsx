import { useEffect, useState, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useLatestRequest } from '@/hooks/useLatestRequest'
import { useScopedAction } from '@/hooks/useScopedAction'
import { BarChart, ResponsiveContainer, CartesianGrid } from 'recharts'
import { ChartBar as Bar, ChartTooltip as Tooltip, ChartXAxis as XAxis, ChartYAxis as YAxis } from '@/lib/rechartsCompat'
import { BarChart2, AlertTriangle, Users, TrendingUp, Trash2, DollarSign, Download, Wrench, ClipboardCopy } from 'lucide-react'
import * as XLSX from 'xlsx'
import { reportApi } from './reportApi'
import { REASON_LABEL } from '@/types/writeoff'
import type { WriteoffReason } from '@/types/writeoff'
import type { SalesPeriodReport, LowStockProduct, Debtor } from '@/types/report'
import { AnalyticsLayout as Layout } from '@/features/analytics/AnalyticsLayout'
import { Card, Table, Badge } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDate, formatDateTime } from '@/lib/utils'
import { businessDateKey } from '@/lib/businessDate'
import { useAuthStore } from '@/stores/authStore'
import { staffApi } from '@/features/staff/staffApi'
import type { SalaryFundSource, TireServiceReport, TireServiceReportRow } from '@/features/staff/staffApi'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { TireServiceDetails, tireOperationLabel } from './TireServiceDetails'
import { shiftApi } from '@/features/pos/shiftApi'
import { SoldItemsMobile } from './SoldItemsMobile'
import { soldSupplierOptions, soldSupplierNames, soldReorderExport, UNKNOWN_SUPPLIER, supplierReportNote } from './soldSupplierReport'
import { filterSoldRows, soldSellerOptions, soldSellerNames, soldTotals, soldReportNote, soldCopyText } from './soldReportData'
import { useSoldItemsReport } from './useSoldItemsReport'
import { periodReportNote } from './periodReportData'
import { writeoffReportDate, type WriteoffSummary } from './writeoffReportData'

type Tab = 'today' | 'sold' | 'tire' | 'weekly' | 'period' | 'lowstock' | 'debtors' | 'writeoffs' | 'profit'

interface ProfitReport {
  from: string; to: string
  revenue: number; cogs: number; gross_margin: number
  expenses: number | null; net_profit: number | null
  zero_cost_lines?: number
}

const PAYMENT_COLOR: Record<string, 'green' | 'blue' | 'red'> = {
  cash: 'green', card: 'blue', debt: 'red',
}
const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Готівка', card: 'Картка', transfer: 'Переказ', account: 'Рахунок клієнта', debt: 'Борг', mixed: 'Змішана',
}

interface WeekDay { date: string; revenue: number; sales: number; gross_revenue: number; returns_total: number }


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
  const date = new Date(businessDateKey() + 'T12:00:00Z')
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

export default function DailyReport() {
  const [searchParams] = useSearchParams()
  const role = (useAuthStore((state) => state.session)?.user?.app_metadata?.role as string | undefined) ?? ''
  const canSeeFullReports = role === 'owner' || role === 'admin'
  const canSeeTireReport = canSeeFullReports || role === 'cashier'
  const [tab, setTab]           = useState<Tab>(() => searchParams.get('tab') === 'tire' && canSeeTireReport ? 'tire' : canSeeFullReports ? 'today' : 'sold')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const reportScope = JSON.stringify([tab,dateFrom,dateTo,role,businessDateKey()])
  const [reportState,setReportState] = useState<{key:string;data:SalesPeriodReport}|null>(null)
  const [weeklyState,setWeeklyState] = useState<{key:string;data:WeekDay[]}|null>(null)
  const [summaryError,setSummaryError] = useState<{key:string;message:string}|null>(null)
  const report = reportState?.key===reportScope ? reportState.data : null
  const weekly = weeklyState?.key===reportScope ? weeklyState.data : []
  const reportError = summaryError?.key===reportScope ? summaryError.message : ''
  const [lowStock, setLowStock] = useState<LowStockProduct[]>([])
  const [debtors, setDebtors]   = useState<Debtor[]>([])
  const [writeoffState, setWriteoffState] = useState<{ key: string; data: WriteoffSummary } | null>(null)
  const [writeoffErrorState, setWriteoffErrorState] = useState<{ key: string; message: string } | null>(null)
  const writeoffs = writeoffState?.key === reportScope ? writeoffState.data : null
  const writeoffError = writeoffErrorState?.key === reportScope ? writeoffErrorState.message : ''
  const [profit, setProfit]       = useState<ProfitReport | null>(null)
  const [loading, setLoading]   = useState(false)


  // Продані товари за період — один зведений список для дозамовлення.
  const todayKey = businessDateKey()
  const [soldFrom, setSoldFrom] = useState(todayKey)
  const [soldTo, setSoldTo] = useState(todayKey)
  const [soldSupplierId, setSoldSupplierId] = useState('')
  const [soldSellerId, setSoldSellerId] = useState('')
  const [soldSearch, setSoldSearch] = useState('')
  const {rows: allSoldItems, loading: soldLoading, error: soldError} = useSoldItemsReport(
    tab === 'today' ? todayKey : soldFrom, tab === 'today' ? todayKey : soldTo,
    tab === 'today' || tab === 'sold', tab + ':' + role)
  const supplierOptions = useMemo(() => soldSupplierOptions(allSoldItems), [allSoldItems])
  const sellerOptions = useMemo(() => soldSellerOptions(allSoldItems), [allSoldItems])
  const soldItems = useMemo(() => tab === 'sold'
    ? filterSoldRows(allSoldItems,soldSupplierId,soldSellerId,soldSearch) : allSoldItems,
    [allSoldItems,tab,soldSupplierId,soldSellerId,soldSearch])
  const supplierLabel = !soldSupplierId ? 'Усі постачальники'
    : soldSupplierId === UNKNOWN_SUPPLIER ? 'Постачальника не визначено'
    : supplierOptions.find(item => item.id === soldSupplierId)?.name ?? 'Вибраний постачальник'
  const sellerLabel = !soldSellerId ? 'Усі продавці' : sellerOptions.find(item=>item.id===soldSellerId)?.name ?? 'Вибраний продавець'
  const soldHeading = `Продані товари: ${soldFrom} — ${soldTo} | ${supplierLabel} | ${sellerLabel}${soldSearch.trim() ? ' | Пошук: '+soldSearch.trim() : ''}`
  const [tireDate, setTireDate] = useState(() => {
    const requested = searchParams.get('date') ?? ''
    return /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested <= todayKey &&
      !Number.isNaN(Date.parse(requested)) && new Date(requested).toISOString().slice(0, 10) === requested ? requested : todayKey
  })
  const [tireEmployeeId, setTireEmployeeId] = useState(searchParams.get('employee') ?? '')
  const [tireReport, setTireReport] = useState<TireServiceReport | null>(null)
  const [tireError, setTireError] = useState(false)
  const tireRows = useMemo(() => tireReport?.data.filter(row => !tireEmployeeId || row.employee_id === tireEmployeeId) ?? [], [tireReport, tireEmployeeId])
  const [tireLoading, setTireLoading] = useState(false)
  const tireAction = useScopedAction(JSON.stringify([tab, tireDate, tireEmployeeId, role]))
  const reportRequests = useLatestRequest([tab, dateFrom, dateTo, role, todayKey])
  const tireRequests = useLatestRequest([tab, tireDate])

  // A changed filter is not a report: do not export previous rows under new dates.
  useEffect(() => {
    setReportState(null)
    setWeeklyState(null)
    setSummaryError(null)
    setLowStock([])
    setDebtors([])
    setWriteoffState(null)
    setWriteoffErrorState(null)
    setProfit(null)
    setLoading(false)
  }, [tab, dateFrom, dateTo])

  useEffect(() => {
    setTireReport(null)
    setTireError(false)
    setTireLoading(false)
  }, [tab, tireDate])



  async function copySoldItems() {
    if (soldLoading || soldError) return
    if (soldItems.length === 0) {
      toast.error('Немає товарів для копіювання')
      return
    }
    const text = soldCopyText(soldItems,soldHeading)
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Список проданих товарів скопійовано')
    } catch {
      toast.error('Не вдалося скопіювати список')
    }
  }

  function printSoldItems() {
    if (soldLoading || soldError || !soldItems.length) return
    const escapeHtml = (value: unknown) => String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const period = soldFrom === soldTo ? soldFrom : `${soldFrom} — ${soldTo}`
    const rows = soldItems.map((it, i) =>
      `<tr><td>${i + 1}</td><td>${escapeHtml(it.sku)}</td><td>${escapeHtml(it.barcode || '—')}</td>` +
      `<td>${escapeHtml(it.name)}<br><small>${escapeHtml(soldSupplierNames(it))}</small></td><td style="text-align:right;font-weight:bold">${it.qty_net} ${escapeHtml(it.unit)}</td>` +
      `<td style="text-align:right">${it.qty_on_hand} ${escapeHtml(it.unit)}</td><td>${escapeHtml(soldSellerNames(it))}</td><td>${escapeHtml(formatMoney(it.net_revenue))}</td></tr>`).join('')
    const w = window.open('', '_blank', 'width=900,height=900')
    if (!w) return
    w.document.write(`<html><head><title>Продані товари ${period}</title><style>
      body{font-family:Arial,sans-serif;font-size:12px;padding:16px}
      table{width:100%;border-collapse:collapse}
      td,th{border:1px solid #ccc;padding:4px 6px;text-align:left}
      th{background:#f3f3f3}
    </style></head><body>
      <h3>Продані товари за ${period} — для дозамовлення</h3>
      <p>${escapeHtml(soldHeading)}</p><p>${escapeHtml(supplierReportNote)}</p><p>${escapeHtml(soldReportNote)}</p>
      <table><tr><th>#</th><th>Артикул</th><th>Штрихкод</th><th>Назва</th><th>Чисто продано</th><th>Залишок</th><th>Продавці</th><th>Сума</th></tr>${rows}</table><p>Разом: ${escapeHtml(formatMoney(soldTotals(soldItems).revenue))}</p>
    </body></html>`)
    w.document.close()
    w.focus()
    w.print()
  }

  const loadToday = useCallback(async () => {
    const isCurrent=reportRequests.begin()
    setLoading(true);setReportState(null);setSummaryError(null)
    try {
      const {data}=await reportApi.salesPeriod(todayKey,todayKey)
      if(isCurrent())setReportState({key:reportScope,data})
    } catch(error) { if(isCurrent())setSummaryError({key:reportScope,message:error instanceof Error?error.message:'Не вдалося завантажити звіт'}) }
    finally { if(isCurrent())setLoading(false) }
  }, [todayKey,reportScope])

  const loadWeekly = useCallback(async () => {
    const isCurrent=reportRequests.begin()
    setLoading(true);setWeeklyState(null);setSummaryError(null)
    try {
      const {data}=await reportApi.weekly()
      if(isCurrent())setWeeklyState({key:reportScope,data})
    } catch(error) { if(isCurrent())setSummaryError({key:reportScope,message:error instanceof Error?error.message:'Не вдалося завантажити звіт'}) }
    finally { if(isCurrent())setLoading(false) }
  }, [reportScope])

  const loadPeriod = useCallback(async () => {
    const isCurrent=reportRequests.begin()
    setLoading(true);setReportState(null);setSummaryError(null)
    try {
      if(!dateFrom||!dateTo)throw Error('Виберіть дату початку й завершення')
      const {data}=await reportApi.salesPeriod(dateFrom,dateTo)
      if(isCurrent())setReportState({key:reportScope,data})
    } catch(error) { if(isCurrent())setSummaryError({key:reportScope,message:error instanceof Error?error.message:'Не вдалося завантажити звіт'}) }
    finally { if(isCurrent())setLoading(false) }
  }, [dateFrom,dateTo,reportScope])

  const loadProfit = useCallback(async () => {
    const isCurrent = reportRequests.begin()
    setLoading(true)
    try {
      const now = new Date()
      const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
      const to   = now.toISOString()
      const { data } = await reportApi.profit(from, to)
      if (!isCurrent()) return
      setProfit(data)
    } catch { if (isCurrent()) toast.error('Помилка завантаження') } finally { if (isCurrent()) setLoading(false) }
  }, [])

  const loadLowStock = useCallback(async () => {
    const isCurrent = reportRequests.begin()
    setLoading(true)
    try {
      const { data } = await reportApi.lowStock()
      if (!isCurrent()) return
      setLowStock(data)
    } catch { if (isCurrent()) toast.error('Помилка завантаження') } finally { if (isCurrent()) setLoading(false) }
  }, [])

  const loadDebtors = useCallback(async () => {
    const isCurrent = reportRequests.begin()
    setLoading(true)
    try {
      const { data } = await reportApi.debtors()
      if (!isCurrent()) return
      setDebtors(data)
    } catch { if (isCurrent()) toast.error('Помилка завантаження') } finally { if (isCurrent()) setLoading(false) }
  }, [])

  const loadWriteoffs = useCallback(async () => {
    const isCurrent = reportRequests.begin()
    setLoading(true)
    setWriteoffState(null)
    setWriteoffErrorState(null)
    try {
      const { data } = await reportApi.writeoffsSummary()
      if (!isCurrent()) return
      setWriteoffState({ key: reportScope, data })
    } catch (error) {
      if (!isCurrent()) return
      const message = error instanceof Error ? error.message : 'Не вдалося завантажити звіт списань'
      setWriteoffErrorState({ key: reportScope, message })
    } finally { if (isCurrent()) setLoading(false) }
  }, [reportScope])

  const loadTireReport = useCallback(async () => {
    if (!canSeeTireReport || !tireDate) return
    const isCurrent = tireRequests.begin()
    setTireLoading(true)
    setTireError(false)
    try {
      const report = await staffApi.tireServiceReport(tireDate)
      if (!isCurrent()) return
      setTireReport(report)
    } catch {
      if (!isCurrent()) return
      setTireReport(null)
      setTireError(true)
      toast.error('Не вдалося завантажити звіт шиномонтажу')
    } finally {
      if (isCurrent()) setTireLoading(false)
    }
  }, [canSeeTireReport, tireDate])

  async function handOverTireCash(row: TireServiceReportRow) {
    if (!isDesktopRuntime() || !canSeeTireReport || tireLoading || tireError || tireReport?.date !== tireDate || row.cash_pending <= 0) return
    const attempt = tireAction.begin()
    if (!attempt) return
    try {
      const { data: shift } = await shiftApi.current({ silent: true })
      if (!attempt.isCurrent()) return
      if (!shift?.id) { toast.error('Спочатку відкрийте касову зміну'); return }
      if (!window.confirm(`Внести ${formatMoney(row.cash_pending)} каси шиномонтажу за ${tireDate} від ${row.employee_name} у поточну зміну?`)) return
      await staffApi.tireCashHandover({
        employee_id: row.employee_id, employee_name: row.employee_name, work_date: tireDate,
        shift_id: shift.id, amount: row.cash_pending, operation_id: crypto.randomUUID(),
      })
      if (!attempt.isCurrent()) return
      toast.success('Касу шиномонтажу внесено в поточну зміну')
      await loadTireReport()
    } catch (error) {
      if (attempt.isCurrent()) toast.error(error instanceof Error ? error.message : 'Не вдалося внести касу шиномонтажу')
    } finally { attempt.finish() }
  }

  async function payTireSalary(row: TireServiceReportRow, fundSource: SalaryFundSource) {
    if (!isDesktopRuntime() || !canSeeFullReports || tireLoading || tireError || tireReport?.date !== tireDate || !row.salary_ready || row.payable_due <= 0) return
    const attempt = tireAction.begin()
    if (!attempt) return
    try {
      const { data: shift } = await shiftApi.current({ silent: true })
      if (!attempt.isCurrent()) return
      if (!shift?.id) { toast.error('Спочатку відкрийте касову зміну'); return }
      const question = fundSource === 'owner_funds'
        ? `Внести ${formatMoney(row.payable_due)} власних коштів власника та одразу виплатити зарплату ${row.employee_name} за ${tireDate}? Залишок каси не зміниться.`
        : `Видати ${formatMoney(row.payable_due)} зарплати ${row.employee_name} за ${tireDate} з поточної каси?`
      if (!window.confirm(question)) return
      const result = await staffApi.dailyPayout({
        employee_id: row.employee_id, employee_name: row.employee_name, method: 'cash',
        fund_source: fundSource, shift_id: shift.id, work_date: tireDate,
      })
      if (!attempt.isCurrent()) return
      toast.success(fundSource === 'owner_funds'
        ? `Виплачено ${formatMoney(result.data.amount)} власними коштами власника`
        : `Виплачено з каси ${formatMoney(result.data.amount)}`)
      await loadTireReport()
    } catch (error) {
      if (attempt.isCurrent()) toast.error(error instanceof Error ? error.message : 'Не вдалося виплатити зарплату')
    } finally { attempt.finish() }
  }

  const exportToExcel = useCallback(() => {
    if (loading || soldLoading || tireLoading || ((tab === 'sold' || tab === 'today') && soldError)) { toast.error('Дочекайтеся коректного звіту за обраний період'); return }
    try {
      let dataToExport: any[] = []
      let fileName = 'zvit'

      if (tab === 'today') {
        if (!soldItems.length) {
          toast.error('Немає проданих товарів за сьогодні')
          return
        }
        dataToExport = soldReorderExport(soldItems, 'Усі постачальники').map(row => ({'Дата':todayKey,...row}))
        fileName = 'sold_items_today'
      } else if (tab === 'period') {
        if (!report) {
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
          'Сума чеків (грн)': d.gross_revenue / 100,
          'Повернення (грн)': d.returns_total / 100,
          'Після повернень (грн)': d.revenue / 100,
        }))
        fileName = 'weekly_sales'
      } else if (tab === 'sold') {
        if (!soldItems.length) {
          toast.error('Немає проданих товарів за вибраний період')
          return
        }
        dataToExport = soldReorderExport(soldItems, supplierLabel).map(row => ({'Від':soldFrom,'До':soldTo,'Продавець у звіті':sellerLabel,'Пошук':soldSearch.trim(),...row}))
        const supplierFile = supplierLabel.replace(/[<>:"/\\|?*]/g, '_').slice(0, 60)
        fileName = `sold_items_${soldFrom}_${soldTo}_${supplierFile}`
      } else if (tab === 'tire') {
        if (!tireReport || tireError || !tireDate || !tireRows.length) {
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
          'Можна видати зараз (грн)': row.payable_due / 100,
          'Ставка попередня': row.daily_rate_projected ? 'Так' : 'Ні',
        }))
        const selectedIds = new Set(tireRows.map(row => row.employee_id))
        const names = new Map(tireRows.map(row => [row.employee_id, row.employee_name]))
        const receiptRows = tireReport.receipts.filter(row => selectedIds.has(row.employee_id)).map(row => ({
          'День робіт': tireDate, 'Працівник': row.employee_name, 'Чек': row.sale_number,
          'Час (Київ)': new Date(row.completed_at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }),
          'Касир': row.cashier_name ?? '', 'Роботи': row.services?.map(item => `${item.description} × ${item.qty}`).join('; ') ?? '',
          'Коментар': row.notes ?? '', 'Оплата': PAYMENT_LABELS[row.payment_method] ?? row.payment_method,
          'Сума робіт (грн)': row.service_revenue / 100, 'Нарахування за чек (грн)': row.commission_earned === undefined ? '' : row.commission_earned / 100,
        }))
        const operations = [
          ...(tireReport.salary_operations ?? []).map(row => ({ ...row, label: tireOperationLabel(row) })),
          ...(tireReport.cash_handovers ?? []).map(row => ({ ...row, label: 'Готівку передано до каси' })),
        ].filter(row => selectedIds.has(row.employee_id)).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(row => ({
          'День робіт': row.work_date, 'Працівник': names.get(row.employee_id), 'Операція': row.label,
          'Фактичний час (Київ)': new Date(row.created_at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }),
          'Виконав': row.cashier_name ?? '', 'Сума (грн)': row.amount / 100, 'Примітка': row.note ?? '',
        }))
        const workbook = XLSX.utils.book_new()
        for (const [name, rows] of [['Підсумок', dataToExport], ['Чеки', receiptRows], ['Операції', operations]] as const) {
          XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), name)
        }
        XLSX.writeFile(workbook, `tire_service_${tireDate}.xlsx`)
        toast.success('Експортовано підсумок, чеки та операції шиномонтажу')
        return
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
          const cost = w.total_cost
          return {
            'Дата': writeoffReportDate(w.created_at),
            'Причина': REASON_LABEL[w.reason as WriteoffReason] || w.reason,
            'Кількість позицій': w.items.length,
            'Собівартість (грн)': cost / 100,
          }
        })
        fileName = 'writeoffs_' + writeoffs.month
      } else if (tab === 'profit') {
        if (!profit) {
          toast.error('Немає даних для експорту')
          return
        }
        dataToExport = [
          { 'Показник': 'Виручка', 'Значення (грн)': profit.revenue / 100 },
          { 'Показник': 'Собівартість (COGS)', 'Значення (грн)': -profit.cogs / 100 },
          { 'Показник': 'Валовий прибуток', 'Значення (грн)': profit.gross_margin / 100 },
          { 'Показник': 'Операційні витрати', 'Значення (грн)': profit.expenses === null ? 'Не обчислено' : -profit.expenses / 100 },
          { 'Показник': 'Чистий прибуток', 'Значення (грн)': profit.net_profit === null ? 'Не обчислено: немає повного обліку витрат' : profit.net_profit / 100 },
        ]
        fileName = 'profit_loss'
      }

      const worksheet = XLSX.utils.json_to_sheet(dataToExport)
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Звіт')
      if(tab==='period' && report) {
        XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet([
          {Показник:'Період',Значення:dateFrom+' — '+dateTo},
          {Показник:'Сума чеків',Значення:report.total_revenue/100},
          {Показник:'Повернення',Значення:report.returns_total/100},
          {Показник:'Після повернень',Значення:report.net_revenue/100},
          ...Object.entries(report.by_method).map(([method,amount])=>({Показник:PAYMENT_LABELS[method],Значення:amount/100})),
          {Показник:'Примітка',Значення:periodReportNote},
          {Показник:'Джерело',Значення:isDesktopRuntime()?'Локальна база':'Серверна копія; повнота на поточний час не підтверджена'},
        ]),'Підсумок')
      }
      if (tab === 'writeoffs' && writeoffs) {
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
          { Показник: 'Місяць за київським часом', Значення: writeoffs.month },
          { Показник: 'Актів', Значення: writeoffs.count },
          { Показник: 'Собівартість (грн)', Значення: writeoffs.total_cost / 100 },
          { Показник: 'Джерело', Значення: isDesktopRuntime() ? 'Локальна база' : 'Серверна копія; повнота на поточний час не підтверджена' },
        ]), 'Підсумок')
      }
      const exportName = tab === 'sold' ? `${fileName}.xlsx` : `${fileName}_${businessDateKey()}.xlsx`
      XLSX.writeFile(workbook, exportName)
      toast.success('Звіт успішно експортовано в Excel')
    } catch (err) {
      toast.error(`Помилка експорту: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [tab, dateFrom, dateTo, report, weekly, lowStock, debtors, writeoffs, profit, soldItems, soldFrom, soldTo, supplierLabel, sellerLabel, soldSearch, soldError, todayKey, tireRows, tireReport, tireError, tireDate, loading, soldLoading, tireLoading])

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
  ].filter((item) => canSeeFullReports || item.id === 'sold' || (canSeeTireReport && item.id === 'tire'))

  const weeklyTotal = weekly.reduce((s, d) => s + d.revenue, 0)
  const weeklySales = weekly.reduce((s, d) => s + d.sales, 0)
  const {qty: soldQty, revenue: soldRevenue} = soldTotals(soldItems)
  const soldReady = !soldLoading && !soldError

  const chartData = weekly.map((d) => ({
    name: formatDate(d.date).slice(0, 5),
    revenue: d.revenue,
    sales: d.sales,
  }))

  return (
    <Layout title="Продажі та звіти">
      <div className="flex justify-between items-center gap-2 mb-6 flex-wrap">
        <label className="w-full min-w-0 md:hidden text-sm text-gray-600">Звіт
          <select value={tab} disabled={tireAction.busy} onChange={e => { if (!tireAction.isBusy()) setTab(e.target.value as Tab) }} className="mt-1 w-full min-w-0 rounded-lg border border-gray-200 bg-white px-3 py-3 text-base text-gray-900">
            {TABS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        <div className="hidden md:flex gap-2 flex-wrap">
          {TABS.map((t) => (
            <button key={t.id} disabled={tireAction.busy} onClick={() => { if (!tireAction.isBusy()) setTab(t.id as Tab) }}
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

        <button onClick={exportToExcel} disabled={(tab === 'sold' || tab === 'today') && (!soldReady || soldItems.length === 0)}
          className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white font-medium px-4 py-2 rounded-lg text-sm transition-colors cursor-pointer">
          <Download size={15} />
          Експорт в Excel
        </button>
      </div>

      {['today','weekly','period'].includes(tab) && reportError && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{reportError}</p>}
      {['today','weekly','period'].includes(tab) && loading && <p role="status" className="mb-4 text-sm text-gray-500">Завантаження звіту…</p>}
      {/* Сьогодні */}
      {tab === 'today' && report && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4 mb-3">
            {[
              { label: 'Товарних позицій', value: soldReady ? String(soldItems.length) : '—' },
              { label: 'Чисто продано одиниць', value: soldReady ? String(soldQty) : '—' },
              { label: 'Сума товарів після повернень', value: soldReady ? formatMoney(soldRevenue) : '—' },
              { label: 'Прийнято оплат до повернень', value: formatMoney(report.payment_received_total) },
              { label: 'Готівка', value: formatMoney(report.by_method.cash) },
              { label: 'Картка', value: formatMoney(report.by_method.card) },
              { label: 'Переказ', value: formatMoney(report.by_method.transfer) },
              { label: 'З рахунку клієнта', value: formatMoney(report.by_method.account) },
            ].map(({ label, value }) => (
              <Card key={label} padding="none" className="min-w-0 p-3 md:p-6">
                <p className="text-xs text-gray-400 mb-1">{label}</p>
                <p className="text-lg md:text-xl font-bold text-gray-900 [overflow-wrap:anywhere]">{value}</p>
              </Card>
            ))}
          </div>
          <p className="mb-4 text-xs text-gray-500">
            {soldReportNote}
            Передоплати замовлень рахуються окремо за датою прийняття грошей.
            {' '}{periodReportNote}
          </p>

          <Card padding="none">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between border-b border-gray-100 px-4 py-3">
              <div className="min-w-0">
                <h3 className="font-bold text-gray-900">Продані товари за сьогодні</h3>
                <p className="text-xs text-gray-500">Один товар — один рядок, незалежно від кількості чеків</p>
              </div>
              <div className="min-w-0 md:text-right">
                <p className="text-xs text-gray-500">Сума товарів за день</p>
                <p className="text-lg font-bold text-gray-900">{soldReady ? formatMoney(soldRevenue) : '—'}</p>
              </div>
            </div>
            {soldLoading ? <p className="p-6 text-gray-500">Формуємо список…</p> : soldError ? <p role="alert" className="p-6 text-red-700">{soldError}</p> : soldItems.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400">Проданих товарів за сьогодні немає</div>
            ) : (
              <>
              <SoldItemsMobile items={soldItems} />
              <div className="hidden md:block max-h-[55vh] overflow-auto">
                <table className="w-full min-w-[620px] text-sm">
                  <thead className="sticky top-0 bg-gray-50 text-xs text-gray-500 shadow-sm">
                    <tr>
                      <th className="px-4 py-3 text-left">Назва товару</th>
                      <th className="px-2 py-3 text-left">Артикул</th>
                      <th className="px-2 py-3 text-right">Чисто продано</th>
                      <th className="px-4 py-3 text-right">Сума</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {soldItems.map((item) => (
                      <tr key={item.product_id} className="hover:bg-gray-50">
                        <td data-label="Назва товару" className="px-4 py-2 font-medium text-gray-900">{item.name}</td>
                        <td data-label="Артикул" className="px-2 py-2 font-mono text-xs text-gray-600">{item.sku || '—'}</td>
                        <td data-label="Продано" className="px-2 py-2 text-right font-bold">{item.qty_net} {item.unit}</td>
                        <td data-label="Сума" className="px-4 py-2 text-right font-semibold text-gray-900">{formatMoney(item.net_revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
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
              <div className="analytics-sold-actions grid min-w-0 grid-cols-2 gap-2 lg:flex lg:flex-wrap lg:items-end">
                <label className="min-w-0 text-xs font-medium text-gray-600">
                  Від
                  <input type="date" value={soldFrom} max={soldTo}
                    onChange={(e) => {
                      const value = e.target.value
                      setSoldFrom(value)
                      if (value > soldTo) setSoldTo(value)
                    }}
                    className="mt-1 block w-full min-w-0 max-w-full rounded-lg border border-gray-200 px-2 py-2 text-base md:text-sm text-gray-800" />
                </label>
                <label className="min-w-0 text-xs font-medium text-gray-600">
                  До
                  <input type="date" value={soldTo} min={soldFrom} max={todayKey}
                    onChange={(e) => {
                      const value = e.target.value
                      setSoldTo(value)
                      if (value < soldFrom) setSoldFrom(value)
                    }}
                    className="mt-1 block w-full min-w-0 max-w-full rounded-lg border border-gray-200 px-2 py-2 text-base md:text-sm text-gray-800" />
                </label>
                <button onClick={copySoldItems} disabled={soldItems.length === 0 || soldLoading}
                  className="flex min-h-[44px] min-w-0 items-center justify-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40">
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
            <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2">
              <label className="min-w-0 text-sm font-medium text-gray-700">
                Знайти проданий товар
                <input type="search" value={soldSearch} onChange={event=>setSoldSearch(event.target.value)}
                  placeholder="Назва, артикул або штрихкод"
                  className="mt-1 block min-h-[44px] w-full min-w-0 rounded-lg border border-gray-200 px-3 text-base" />
              </label>
              <label className="min-w-0 text-sm font-medium text-gray-700">
                Продавець
                <select aria-label="Продавець" value={soldSellerId} onChange={event=>setSoldSellerId(event.target.value)} disabled={soldLoading}
                  className="mt-1 block min-h-[44px] w-full min-w-0 rounded-lg border border-gray-200 bg-white px-3 text-base">
                  <option value="">Усі продавці</option>
                  {soldSellerId && !sellerOptions.some(item=>item.id===soldSellerId) &&
                    <option value={soldSellerId}>Вибраний продавець — немає операцій</option>}
                  {sellerOptions.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <p className="text-xs text-gray-500 md:col-span-2">Продавець — менеджер, записаний у чеку, або касир для звичайного продажу. Повернення віднесено до продавця початкового чека.</p>
            </div>
            <div className="mt-4 min-w-0 border-t border-gray-100 pt-4">
              <label className="block min-w-0 text-sm font-medium text-gray-700">
                Постачальник
                <select aria-label="Постачальник для дозамовлення" value={soldSupplierId}
                  onChange={event => setSoldSupplierId(event.target.value)} disabled={soldLoading}
                  className="mt-1 block min-h-[44px] w-full min-w-0 max-w-full rounded-lg border border-gray-200 bg-white px-3 text-base md:max-w-md md:text-sm">
                  <option value="">Усі постачальники</option>
                  <option value={UNKNOWN_SUPPLIER}>Постачальника не визначено</option>
                  {soldSupplierId && soldSupplierId !== UNKNOWN_SUPPLIER && !supplierOptions.some(item => item.id === soldSupplierId) &&
                    <option value={soldSupplierId}>Вибраний постачальник — немає продажів</option>}
                  {supplierOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <p className="mt-2 text-xs leading-relaxed text-gray-500">{supplierReportNote}</p>
              <p className="mt-2 text-xs leading-relaxed text-gray-500">{soldReportNote}</p>
            </div>
          </Card>

          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card>
              <p className="text-xs text-gray-400">Товарних позицій</p>
              <p className="text-2xl font-bold text-gray-900">{soldReady ? soldItems.length : '—'}</p>
            </Card>
            <Card>
              <p className="text-xs text-gray-400">Чисто продано</p>
              <p className="text-2xl font-bold text-gray-900">{soldReady ? soldQty : '—'}</p>
            </Card>
            <Card>
              <p className="text-xs text-gray-400">Чиста сума продажів</p>
              <p className="text-2xl font-bold text-gray-900">{soldReady ? formatMoney(soldRevenue) : '—'}</p>
            </Card>
          </div>

          <Card padding="none">
            {soldLoading ? (
              <div className="flex min-h-48 items-center justify-center text-sm text-gray-400">Формуємо список…</div>
            ) : soldError ? (
              <p role="alert" className="p-6 text-center text-red-700">{soldError}</p>
            ) : soldItems.length === 0 ? (
              <div className="flex min-h-48 items-center justify-center px-4 text-center text-sm text-gray-400">
                За вибраним періодом, пошуком і фільтрами операцій із товарами немає
              </div>
            ) : (
              <>
              <SoldItemsMobile items={soldItems} showSuppliers />
              <div className="hidden md:block max-h-[65vh] overflow-auto">
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
                        <td data-label="Артикул" className="px-4 py-2 font-mono text-xs text-gray-600">{item.sku || '—'}</td>
                        <td data-label="Штрихкод" className="px-2 py-2 font-mono text-xs text-gray-600">{item.barcode || '—'}</td>
                        <td data-label="Назва" className="px-2 py-2 font-medium text-gray-900">{item.name}<div className="mt-1 text-xs font-normal text-gray-500">{soldSupplierNames(item)}<br />Продавці: {soldSellerNames(item)}</div></td>
                        <td data-label="Полиця" className="px-2 py-2 text-gray-500">{item.storage_bin || '—'}</td>
                        <td data-label="Чисто продано" className="px-2 py-2 text-right font-bold text-gray-900">{item.qty_net} {item.unit}{item.qty_returned > 0 && <div className="text-xs font-normal text-gray-500">Продано {item.qty_sold}; повернуто {item.qty_returned}</div>}</td>
                        <td data-label="Залишок" className={`px-2 py-2 text-right font-semibold ${item.qty_on_hand <= 0 ? 'text-red-600' : 'text-gray-600'}`}>
                          {item.qty_on_hand} {item.unit}
                        </td>
                        <td data-label="Сума" className="px-4 py-2 text-right text-gray-600">{formatMoney(item.net_revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </Card>
        </>
      )}

      {/* Шиномонтаж — чеки, відкладена каса та зарплата */}
      {tab === 'tire' && canSeeTireReport && <TireServiceDetails
        report={tireReport} date={tireDate} today={todayKey} employeeId={tireEmployeeId}
        loading={tireLoading} error={tireError}
        onDate={date => { if (!tireAction.isBusy()) setTireDate(date) }}
        onEmployee={id => { if (!tireAction.isBusy()) setTireEmployeeId(id) }}
        onRefresh={() => { if (!tireAction.isBusy()) void loadTireReport() }} canPay={canSeeFullReports} canMutate={isDesktopRuntime()}
        busy={tireAction.busy}
        onHandOver={handOverTireCash} onPay={payTireSalary}
      />}
      {/* 7 днів — графік */}
      {tab === 'weekly' && (
        <>
          <div className="grid grid-cols-2 gap-4 mb-6">
            <Card>
              <p className="text-xs text-gray-400 mb-1">За 7 днів після повернень</p>
              <p className="text-2xl font-bold text-gray-900">{weekly.length && !loading && !reportError ? formatMoney(weeklyTotal) : '—'}</p>
            </Card>
            <Card>
              <p className="text-xs text-gray-400 mb-1">Продажів за 7 днів</p>
              <p className="text-2xl font-bold text-gray-900">{weekly.length && !loading && !reportError ? weeklySales : '—'}</p>
            </Card>
          </div>

          <Card>
            <p className="text-sm font-semibold text-gray-700 mb-4">Сума по днях після повернень</p>
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
                    <td data-label="Дата" className="px-4 py-2">{formatDate(d.date)}</td>
                    <td data-label="Продажів" className="px-4 py-2 text-right">{d.sales}</td>
                    <td data-label="Виручка" className="px-4 py-2 text-right font-mono font-medium">{formatMoney(d.revenue)}</td>
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
                <label htmlFor="period-from" className="block text-xs text-gray-500 mb-1">Від</label>
                <input id="period-from" type="date" value={dateFrom} max={dateTo || todayKey} onChange={(e) => setDateFrom(e.target.value)}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400" />
              </div>
              <div>
                <label htmlFor="period-to" className="block text-xs text-gray-500 mb-1">До</label>
                <input id="period-to" type="date" value={dateTo} min={dateFrom} max={todayKey} onChange={(e) => setDateTo(e.target.value)}
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
                  { label: 'Сума чеків', value: formatMoney(report.total_revenue) },
                  { label: 'Повернення', value: formatMoney(report.returns_total) },
                  { label: 'Після повернень', value: formatMoney(report.net_revenue) },
                ].map(({ label, value }) => (
                  <Card key={label}>
                    <p className="text-xs text-gray-400 mb-1">{label}</p>
                    <p className="text-xl font-bold">{value}</p>
                  </Card>
                ))}
              </div>
              <p className="mb-3 text-xs text-gray-500">{periodReportNote} Готівка: {formatMoney(report.by_method.cash)}; картка: {formatMoney(report.by_method.card)}; переказ: {formatMoney(report.by_method.transfer)}; рахунок клієнта: {formatMoney(report.by_method.account)}; борг: {formatMoney(report.by_method.debt)}.</p>
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
      {tab === 'writeoffs' && writeoffError && <p role="alert" className="text-sm text-red-700 bg-red-50 rounded-lg p-4">{writeoffError}</p>}
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
                  const cost = w.total_cost
                  return (
                    <tr key={w.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td data-label="Дата" className="px-4 py-2">{writeoffReportDate(w.created_at)}</td>
                      <td data-label="Причина" className="px-4 py-2 text-gray-600">{REASON_LABEL[w.reason as WriteoffReason] ?? w.reason}</td>
                      <td data-label="Позицій" className="px-4 py-2 text-right">{w.items.length}</td>
                      <td data-label="Собівартість" className="px-4 py-2 text-right font-mono text-red-600">{formatMoney(cost)}</td>
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
              { label: 'Чистий прибуток', value: profit.net_profit, color: profit.net_profit === null ? 'text-gray-500' : profit.net_profit >= 0 ? 'text-green-700' : 'text-red-700', bold: true, border: true },
            ].map(({ label, value, color, negative, bold, border }) => (
              <div key={label} className={`flex justify-between items-center py-3 ${border ? 'border-t border-gray-200 mt-2' : ''}`}>
                <span className={`text-sm ${bold ? 'font-semibold text-gray-900' : 'text-gray-600'}`}>{label}</span>
                <span className={`text-lg font-bold ${color}`}>
                  {value === null ? 'Не обчислено' : formatMoney(negative ? -value : value)}
                </span>
              </div>
            ))}
            <p className="text-xs text-gray-500 pt-2">Період: поточний місяць. Враховано повернення за датою їх проведення. Валовий прибуток — до операційних витрат; без повного обліку витрат чистий прибуток не обчислюється.</p>
            {Boolean(profit.zero_cost_lines) && <p className="text-xs text-amber-700">У {profit.zero_cost_lines} проданих позиціях закупівля записана як 0. Перевірте собівартість: валовий прибуток може бути завищений. Поточні ціни товарів не підставляються замість історичних.</p>}
          </div>
        ) : (
          <div className="text-center py-16 text-gray-400 text-sm">Завантаження...</div>
        )
      )}
    </Layout>
  )
}
