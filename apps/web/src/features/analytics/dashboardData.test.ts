import { describe, expect, it } from 'vitest'
import { parseDashboardData, parseDashboardTires } from './dashboardData'

const valid = () => ({
  total_revenue: -10000, cogs: -6000, gross_profit: -4000,
  total_receipts: 0, average_receipt: 0,
  daily: [{ date: '2026-10-02', revenue: -10000, profit: -4000 }],
  low_stock: 0, overdue_count: 0, debt: { count: 0, total: 0 },
  inventory: { purchase_value: 0, retail_value: 0 },
})
describe('complete statistics response', () => {
  it('does not treat missing tire-service amounts as zero wages', () => {
    expect(parseDashboardTires([])).toEqual([])
    expect(() => parseDashboardTires([{ employee_id: 'one', employee_name: 'Андрій' }])).toThrow()
    const worker = { employee_id: 'one', employee_name: 'Андрій', services_qty: 1.5,
      service_revenue: 10000, commission_earned: 1260, earned: 1260, paid: 0, due: 1260 }
    expect(parseDashboardTires([worker])).toEqual([worker])
    expect(() => parseDashboardTires([{ ...worker, due: NaN }])).toThrow()
    expect(() => parseDashboardTires(null)).toThrow()
  })
  it('allows a refund-only day with negative revenue and profit', () => {
    expect(parseDashboardData(valid())).toEqual(valid())
  })
  it.each(['total_revenue','cogs','gross_profit','total_receipts','average_receipt','daily','inventory','debt','low_stock','overdue_count'])(
    'rejects a missing %s instead of substituting a zero', field => {
      const value: Record<string, unknown> = valid(); delete value[field]
      expect(() => parseDashboardData(value)).toThrow('INCOMPLETE_DASHBOARD')
    })
  it.each([NaN, Infinity, -Infinity, '1000', null])('rejects an invalid amount %s', value => {
    expect(() => parseDashboardData({ ...valid(), total_revenue: value })).toThrow()
  })
  it('validates nested amounts and counts as well as headline numbers', () => {
    expect(() => parseDashboardData({ ...valid(), inventory: { purchase_value: 1 } })).toThrow()
    expect(() => parseDashboardData({ ...valid(), debt: { count: -1, total: 0 } })).toThrow()
    expect(() => parseDashboardData({ ...valid(), daily: [{ date: '2026-10-02', revenue: 5 }] })).toThrow()
  })
  it('accepts a genuine empty day and compatible extra metadata', () => {
    expect(parseDashboardData({ ...valid(), total_revenue: 0, cogs: 0, gross_profit: 0, daily: [], gross_revenue: 0, refund_total: 0 }))
      .toMatchObject({ total_revenue: 0, daily: [] })
  })
})
