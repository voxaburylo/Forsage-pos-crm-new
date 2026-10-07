import { parseSoldRows, validSoldRange } from './soldReportData'
import { parsePeriodReport } from './periodReportData'
import { api } from '@/lib/api'
import { desktopBridge, isDesktopRuntime } from '@/lib/desktopBridge'
import { productApi } from '@/features/products/productApi'
import { customerApi } from '@/features/customers/customerApi'
import { parseWriteoffSummary } from './writeoffReportData'
import type { Sale } from '@/types/sale'
import type { SalesSummary, SalesPeriodReport, LowStockProduct, Debtor } from '@/types/report'
import { businessDateKey, businessDateRangeUtc } from '@/lib/businessDate'

function localDate(value: string | Date): string {
  return businessDateKey(value)
}

function today(): string {
  return localDate(new Date())
}

async function localSales(from?: string, to?: string): Promise<Sale[]> {
  const local = desktopBridge()?.pos.listSales
  if (!local) throw new Error('Локальний журнал продажів недоступний. Звіт не сформовано.')
  const startDay = from ? localDate(from) : (to ? localDate(to) : null)
  const endDay = to ? localDate(to) : startDay
  const range = startDay && endDay ? businessDateRangeUtc(startDay, endDay) : null
  const result: Sale[] = []
  for (let page = 1; ; page += 1) {
    const batch = await local({
      page,
      per_page: 200,
      date_from: range?.from,
      date_to: range?.to,
    })
    const rows = (batch?.data ?? []) as Sale[]
    result.push(...rows)
    if (page >= Number(batch?.pagination?.total_pages ?? page)) break
    if (!rows.length) throw new Error('Неповний журнал продажів. Звіт не сформовано.')
  }
  return result
}

async function localProducts() {
  const result: any[] = []
  for (let page = 1; ; page += 1) {
    const batch = await productApi.list({ page, per_page: 500 })
    result.push(...batch.data)
    if (page >= batch.pagination.total_pages) break
    if (!batch.data.length) throw new Error('Неповний список товарів. Звіт не сформовано.')
  }
  return result
}
export function salesInRange(sales: Sale[], from?: string, to?: string): Sale[] {
  const fromDay = from ? localDate(from) : null
  const toDay = to ? localDate(to) : null
  return sales.filter((sale) => {
    if (!['completed', 'returned'].includes(sale.status)) return false
    const day = localDate(sale.completed_at)
    return (!fromDay || day >= fromDay) && (!toDay || day <= toDay)
  })
}

type LocalOrderPayment = {
  amount: number
  method: 'cash' | 'card' | 'transfer' | 'account'
  created_at: string
}

async function localOrderPayments(from?: string, to?: string): Promise<LocalOrderPayment[]> {
  const list = desktopBridge()?.orders?.listPaymentsByPeriod
  if (!list) throw new Error('Журнал оплат замовлень недоступний. Звіт не сформовано.')
  const startDay = from ? localDate(from) : (to ? localDate(to) : null)
  const endDay = to ? localDate(to) : startDay
  const range = startDay && endDay ? businessDateRangeUtc(startDay, endDay) : null
  return await list({
    date_from: range?.from,
    date_to: range?.to,
  }) as LocalOrderPayment[]
}

function summarize(sales: Sale[], orderPayments: LocalOrderPayment[] = []) {
  const byMethod = { cash: 0, card: 0, transfer: 0, account: 0, debt: 0 }
  for (const sale of sales) {
    if (sale.is_order_sale) continue
    const cash = Number(sale.cash_amount ?? 0)
    const card = Number(sale.card_amount ?? 0)
    const transfer = Number(sale.transfer_amount ?? 0)
    const debt = Number(sale.debt_amount ?? 0)
    byMethod.cash += cash || (sale.payment_method === 'cash' ? Number(sale.total ?? 0) : 0)
    byMethod.card += card || (sale.payment_method === 'card' ? Number(sale.total ?? 0) : 0)
    byMethod.transfer += transfer || (sale.payment_method === 'transfer' ? Number(sale.total ?? 0) : 0)
    byMethod.debt += debt || (sale.payment_method === 'debt' ? Number(sale.total ?? 0) : 0)
  }
  for (const payment of orderPayments) {
    byMethod[payment.method] += Number(payment.amount ?? 0)
  }
  return {
    total_sales: sales.length,
    total_revenue: sales.reduce((sum, sale) => sum + Number(sale.total ?? 0), 0),
    payment_received_total: byMethod.cash + byMethod.card + byMethod.transfer + byMethod.account,
    by_method: byMethod,
    sales: sales.map((sale) => ({
      id: sale.id,
      sale_number: sale.sale_number,
      total: sale.total,
      payment_method: sale.payment_method,
      status: sale.status,
      completed_at: sale.completed_at,
      customer: sale.customer ?? null,
    })),
  }
}
export const reportApi = {
  salesToday: async (): Promise<{data:SalesSummary}> => {
    const {data:{sales:_sales,daily:_daily,...summary}}=await reportApi.salesPeriod(today(),today())
    void _sales; void _daily
    return {data:summary}
  },

  salesPeriod: async (from=today(),to=from): Promise<{data:SalesPeriodReport}> => {
    if(!validSoldRange(from,to))throw Error('Невірно вибраний період')
    if(isDesktopRuntime()){
      const read=desktopBridge()?.pos.salesPeriodReport
      if(!read)throw Error('Для фінансового звіту потрібна оновлена локальна програма')
      const range=businessDateRangeUtc(from,to)
      return {data:parsePeriodReport(await read({date_from:range.from,date_to:range.to}),from,to)}
    }
    const params=new URLSearchParams({from,to})
    const response=await api.get<{data:unknown}>(`/api/v1/reports/sales/period?${params}`,{silent:true})
    return {data:parsePeriodReport(response.data,from,to)}
  },

  lowStock: async () => {
    if (desktopBridge()) {
      const products = await localProducts()
      return { data: products.filter((product) => product.qty_on_hand <= Number(product.reorder_point ?? 0)) as LowStockProduct[] }
    }
    return api.get<{ data: LowStockProduct[] }>('/api/v1/reports/products/low-stock')
  },

  debtors: async () => {
    if (desktopBridge()) {
      const customers = []
      for (let page = 1; ; page += 1) {
        const result = await customerApi.list({ has_debt: 'true', sort: 'debt', per_page: 500, page })
        customers.push(...result.data)
        if (page >= result.pagination.total_pages) break
        if (!result.data.length) throw new Error('Неповний список боржників. Звіт не сформовано.')
      }
      return { data: customers.map((customer) => ({
        id: customer.id, phone: customer.phone, full_name: customer.full_name, debt_balance: customer.debt_balance,
      })) as Debtor[] }
    }
    return api.get<{ data: Debtor[] }>('/api/v1/reports/customers/debtors')
  },

  weekly: async () => {
    const end=today()
    const dates=Array.from({length:7},(_,index)=>{
      const d=new Date(end+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-6+index)
      return d.toISOString().slice(0,10)
    })
    const {data}=await reportApi.salesPeriod(dates[0],end)
    return {data:dates.map(date=>data.daily.find(row=>row.date===date)
      ?? {date,revenue:0,gross_revenue:0,returns_total:0,sales:0})}
  },

  writeoffsSummary: async () => {
    const month = today().slice(0, 7)
    if (isDesktopRuntime()) {
      const read = desktopBridge()?.warehouse?.writeoffsSummary
      if (!read) throw Error('Для звіту списань потрібна оновлена локальна програма')
      return { data: parseWriteoffSummary(await read({ month }), month) }
    }
    const response = await api.get<{ data: unknown }>(`/api/v1/reports/writeoffs/summary?month=${month}`, { silent: true })
    return { data: parseWriteoffSummary(response.data, month) }
  },

  soldItems: async (from: string, to: string = from) => {
    if (!validSoldRange(from,to)) throw new Error('Невірно вибраний період')
    if (isDesktopRuntime()) {
      const direct = desktopBridge()?.pos.soldItemsReport
      if (!direct) throw new Error('Для цього звіту потрібна оновлена локальна програма')
      const range = businessDateRangeUtc(from,to)
      return { data: parseSoldRows(await direct({date_from:range.from,date_to:range.to})) }
    }
    const params = new URLSearchParams({from,to})
    const response = await api.get<{data:unknown}>(`/api/v1/reports/sold-items?${params}`,{silent:true})
    return {data:parseSoldRows(response.data)}
  },

  dailyControl: async () => {
    if (desktopBridge()) {
      const [allSales, payments] = await Promise.all([localSales(today(), today()), localOrderPayments(today(), today())])
      const sales = salesInRange(allSales, today(), today())
      const summary = summarize(sales, payments)
      const listReturns = desktopBridge()!.pos.listReturns
      if (!listReturns) throw new Error('Журнал повернень недоступний. Звіт не сформовано.')
      const dayReturns: any[] = []
      for (let page = 1; ; page += 1) {
        const batch = await listReturns({ page, per_page: 100 })
        const rows = batch.data ?? []
        dayReturns.push(...rows.filter((item: any) => localDate(item.created_at) === today()))
        if (page >= batch.pagination.total_pages) break
        if (!rows.length) throw new Error('Неповний журнал повернень. Звіт не сформовано.')
      }
      const reasonCounts = new Map<string, number>()
      for (const item of dayReturns) reasonCounts.set(item.reason, (reasonCounts.get(item.reason) ?? 0) + 1)
      const products = { data: await localProducts() }
      return { data: {
        revenue: summary.total_revenue,
        receipts: summary.total_sales,
        avg_receipt: summary.total_sales ? Math.round(summary.total_revenue / summary.total_sales) : 0,
        cash: summary.by_method.cash,
        card: summary.by_method.card,
        debt_sales: summary.by_method.debt,
        discounts: sales.reduce((sum, sale) => sum + Number(sale.discount ?? 0), 0),
        returns_count: dayReturns.length,
        returns_sum: dayReturns.reduce((sum: number, item: any) => sum + Number(item.refund_kopecks ?? 0), 0),
        returns_reasons: [...reasonCounts].map(([reason, count]) => ({ reason, count })),
        recon_diffs: [],
        negative_stock: products.data.filter((product) => product.qty_on_hand < 0).length,
        no_price: products.data.filter((product) => product.retail_price <= 0).length,
      } }
    }
    return api.get<{ data: any }>('/api/v1/reports/daily-control')
  },

  profit: async (from: string, to: string) => {
    if (desktopBridge()) {
      const local = desktopBridge()?.pos.dashboardSummary
      if (!local) throw new Error('Оновіть локальну програму для звіту з поверненнями')
      const range = businessDateRangeUtc(localDate(from), localDate(to))
      const { analytics } = await local({ date_from: range.from, date_to: range.to })
      return { data: { from, to, revenue: analytics.total_revenue, cogs: analytics.cogs,
        gross_margin: analytics.gross_profit, zero_cost_lines: analytics.zero_cost_lines ?? 0, expenses: null, net_profit: null } }
    }
    return api.get<{ data: any }>(`/api/v1/reports/profit?from=${from}&to=${to}`)
  },


}
