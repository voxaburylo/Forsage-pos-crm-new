import { api } from '@/lib/api'
import type { SalesSummary, SalesPeriodReport, LowStockProduct, Debtor } from '@/types/report'

export const reportApi = {
  salesToday: () =>
    api.get<{ data: SalesSummary }>('/api/v1/reports/sales/today'),

  salesPeriod: (from?: string, to?: string) => {
    const params = new URLSearchParams()
    if (from) params.set('from', from)
    if (to)   params.set('to', to)
    const qs = params.toString() ? `?${params.toString()}` : ''
    return api.get<{ data: SalesPeriodReport }>(`/api/v1/reports/sales/period${qs}`)
  },

  lowStock: () =>
    api.get<{ data: LowStockProduct[] }>('/api/v1/reports/products/low-stock'),

  debtors: () =>
    api.get<{ data: Debtor[] }>('/api/v1/reports/customers/debtors'),

  weekly: () =>
    api.get<{ data: Array<{ date: string; revenue: number; sales: number }> }>('/api/v1/reports/sales/weekly'),

  writeoffsSummary: () =>
    api.get<{ data: { count: number; total_cost: number; writeoffs: Array<{ id: string; reason: string; created_at: string; items: Array<{ cost_kopecks: number }> }> } }>('/api/v1/reports/writeoffs/summary'),

  shiftReport: (shiftId: string) =>
    api.get<{ data: unknown }>('/api/v1/reports/shift/' + shiftId),
}
