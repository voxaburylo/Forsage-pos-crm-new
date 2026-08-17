import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { productApi } from '@/features/products/productApi'
import { customerApi } from '@/features/customers/customerApi'
import { warehouseApi } from '@/features/inventory/warehouseApi'
import { useAuthStore } from '@/stores/authStore'
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
  if (!local) return []
  const startDay = from ? localDate(from) : (to ? localDate(to) : null)
  const endDay = to ? localDate(to) : startDay
  const range = startDay && endDay ? businessDateRangeUtc(startDay, endDay) : null
  const result: Sale[] = []
  for (let page = 1; page <= 100; page += 1) {
    const batch = await local({
      page,
      per_page: 200,
      date_from: range?.from,
      date_to: range?.to,
    })
    const rows = (batch?.data ?? []) as Sale[]
    result.push(...rows)
    if (page >= Number(batch?.pagination?.total_pages ?? page) || rows.length < 200) break
  }
  return result
}

async function localProducts() {
  const result: any[] = []
  for (let page = 1; page <= 100; page += 1) {
    const batch = await productApi.list({ page, per_page: 500 })
    result.push(...batch.data)
    if (page >= batch.pagination.total_pages) break
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
  if (!list) return []
  const startDay = from ? localDate(from) : (to ? localDate(to) : null)
  const endDay = to ? localDate(to) : startDay
  const range = startDay && endDay ? businessDateRangeUtc(startDay, endDay) : null
  return await list({
    date_from: range?.from,
    date_to: range?.to,
  }) as LocalOrderPayment[]
}

function summarize(sales: Sale[], orderPayments: LocalOrderPayment[] = []): SalesPeriodReport {
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
  salesToday: async () => {
    if (desktopBridge()) {
      const [allSales, payments] = await Promise.all([localSales(today(), today()), localOrderPayments(today(), today())])
      const report = summarize(salesInRange(allSales, today(), today()), payments)
      const { sales: _sales, ...summary } = report
      return { data: summary as SalesSummary }
      void _sales
    }
    return api.get<{ data: SalesSummary }>('/api/v1/reports/sales/today')
  },

  salesPeriod: async (from?: string, to?: string) => {
    if (desktopBridge()) {
      const effectiveFrom = from ?? today()
      const effectiveTo = to ?? effectiveFrom
      const [allSales, payments] = await Promise.all([
        localSales(effectiveFrom, effectiveTo),
        localOrderPayments(effectiveFrom, effectiveTo),
      ])
      return { data: summarize(salesInRange(allSales, effectiveFrom, effectiveTo), payments) }
    }
    const params = new URLSearchParams()
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    const qs = params.toString() ? `?${params.toString()}` : ''
    return api.get<{ data: SalesPeriodReport }>(`/api/v1/reports/sales/period${qs}`)
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
      const result = await customerApi.list({ has_debt: 'true', sort: 'debt', per_page: 500 })
      return { data: result.data.map((customer) => ({
        id: customer.id, phone: customer.phone, full_name: customer.full_name, debt_balance: customer.debt_balance,
      })) as Debtor[] }
    }
    return api.get<{ data: Debtor[] }>('/api/v1/reports/customers/debtors')
  },

  weekly: async () => {
    if (desktopBridge()) {
      const days = Array.from({ length: 7 }, (_, index) => {
        const date = new Date()
        date.setDate(date.getDate() - (6 - index))
        return localDate(date)
      })
      const sales = await localSales(days[0], days[days.length - 1])
      return { data: days.map((date) => {
        const rows = salesInRange(sales, date, date)
        return { date, revenue: rows.reduce((sum, sale) => sum + sale.total, 0), sales: rows.length }
      }) }
    }
    return api.get<{ data: Array<{ date: string; revenue: number; sales: number }> }>('/api/v1/reports/sales/weekly')
  },

  writeoffsSummary: async () => {
    if (desktopBridge()) {
      const all: any[] = []
      for (let page = 1; page <= 100; page += 1) {
        const batch = await warehouseApi.listWriteoffs({ page, per_page: 200 })
        all.push(...(batch.data ?? []))
        if (page >= Number(batch.pagination?.total_pages ?? 1)) break
      }
      const month = today().slice(0, 7)
      const writeoffs = await Promise.all(all
        .filter((item) => localDate(item.created_at).startsWith(month))
        .map((item) => warehouseApi.getWriteoff(item.id).then((result) => result.data)))
      return { data: {
        count: writeoffs.length,
        total_cost: writeoffs.reduce((sum, item) => sum + (item.items ?? []).reduce((lineSum: number, line: any) => lineSum + Number(line.cost_kopecks ?? 0), 0), 0),
        writeoffs: writeoffs.map((item) => ({
          id: item.id,
          reason: item.reason,
          created_at: item.created_at,
          items: (item.items ?? []).map((line) => ({ cost_kopecks: Number(line.cost_kopecks ?? 0) })),
        })),
      } }
    }
    return api.get<{ data: { count: number; total_cost: number; writeoffs: Array<{ id: string; reason: string; created_at: string; items: Array<{ cost_kopecks: number }> }> } }>('/api/v1/reports/writeoffs/summary')
  },

  soldItems: async (from: string, to: string = from) => {
    if (desktopBridge()) {
      const range = businessDateRangeUtc(localDate(from), localDate(to))
      const direct = desktopBridge()?.pos.soldItemsReport
      if (direct) {
        return { data: await direct({ date_from: range.from, date_to: range.to }) }
      }
      const rows = salesInRange(await localSales(from, to), from, to)
      const grouped = new Map<string, any>()
      for (const sale of rows) {
        for (const item of sale.sale_items ?? []) {
          if (!item.product_id || !item.product) continue
          const current = grouped.get(item.product_id) ?? {
            product_id: item.product_id, sku: item.product.sku, name: item.product.name,
            barcode: item.product.barcode ?? null,
            unit: item.product.unit, qty_sold: 0, qty_returned: 0, qty_net: 0,
            revenue: 0, refund_total: 0, net_revenue: 0,
            qty_on_hand: Number(item.product.qty_on_hand ?? 0), storage_bin: item.product.storage_bin ?? null,
          }
          current.qty_sold += Number(item.qty)
          current.qty_net += Number(item.qty)
          current.revenue += Number(item.total)
          current.net_revenue += Number(item.total)
          current.qty_on_hand = Number(item.product.qty_on_hand ?? current.qty_on_hand)
          grouped.set(item.product_id, current)
        }
      }
      return { data: [...grouped.values()].sort((a, b) => b.qty_net - a.qty_net) }
    }
    const params = new URLSearchParams({ from, to })
    return api.get<{ data: any[] }>(`/api/v1/reports/sold-items?${params.toString()}`, { silent: true })
  },

  dailyControl: async () => {
    if (desktopBridge()) {
      const [allSales, payments] = await Promise.all([localSales(today(), today()), localOrderPayments(today(), today())])
      const sales = salesInRange(allSales, today(), today())
      const summary = summarize(sales, payments)
      const returnsResult = await desktopBridge()!.pos.listReturns?.({ page: 1, per_page: 200 })
      const dayReturns = (returnsResult?.data ?? []).filter((item: any) => localDate(item.created_at) === today())
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
      const sales = salesInRange(await localSales(from, to), from, to)
      const revenue = sales.reduce((sum, sale) => sum + sale.total, 0)
      const cogs = sales.reduce((sum, sale) => sum + (sale.sale_items ?? []).reduce(
        (itemSum, item: any) => itemSum + Number(item.purchase_price ?? 0) * Number(item.qty ?? 0), 0,
      ), 0)
      return { data: { from, to, revenue, cogs, gross_margin: revenue - cogs, expenses: 0, net_profit: revenue - cogs } }
    }
    return api.get<{ data: any }>(`/api/v1/reports/profit?from=${from}&to=${to}`)
  },

  shiftReport: async (shiftId: string) => {
    const local = desktopBridge()?.pos.shiftReport
    if (local) {
      const cashierId = useAuthStore.getState().session?.user?.id ?? ''
      return { data: await local(cashierId) }
    }
    return api.get<{ data: unknown }>('/api/v1/reports/shift/' + shiftId)
  },
}
