import { beforeEach, describe, expect, it, vi } from 'vitest'
const local = vi.hoisted(() => ({
  pos: { listSales: vi.fn(), listReturns: vi.fn() },
  orders: { listPaymentsByPeriod: vi.fn() },
}))
const customers = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: () => local }))
vi.mock('@/features/customers/customerApi', () => ({ customerApi: customers }))
vi.mock('@/features/products/productApi', () => ({ productApi: { list: vi.fn() } }))
vi.mock('@/features/inventory/warehouseApi', () => ({ warehouseApi: {} }))
vi.mock('@/lib/api', () => ({ api: {} }))
import { reportApi } from './reportApi'

describe('complete local report pagination', () => {
  beforeEach(() => { vi.clearAllMocks(); local.orders.listPaymentsByPeriod.mockResolvedValue([]) })
  it('honours the backend page count even when pages are shorter than requested', async () => {
    local.pos.listSales.mockImplementation(async ({ page }) => ({
      data: [{ id: String(page), status: 'completed', total: 100, payment_method: 'cash', completed_at: '2026-09-09T12:00:00Z' }],
      pagination: { total_pages: 3, per_page: 1, page },
    }))
    const report = await reportApi.salesPeriod('2026-09-09', '2026-09-09')
    expect(report.data.total_sales).toBe(3)
    expect(report.data.total_revenue).toBe(300)
    expect(local.pos.listSales).toHaveBeenCalledTimes(3)
  })
  it('rejects missing report pages instead of displaying partial totals', async () => {
    local.pos.listSales.mockResolvedValue({ data: [], pagination: { total_pages: 2 } })
    await expect(reportApi.salesPeriod('2026-09-09', '2026-09-09')).rejects.toThrow('Неповний журнал')
  })
  it('includes debtors beyond the first page', async () => {
    customers.list.mockImplementation(async ({ page }) => ({
      data: [{ id: String(page), full_name: 'Client', debt_balance: 100 }], pagination: { total_pages: 2 },
    }))
    expect((await reportApi.debtors()).data.map(row => row.id)).toEqual(['1', '2'])
  })
})
