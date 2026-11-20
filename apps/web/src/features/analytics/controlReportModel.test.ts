import { describe, expect, it } from 'vitest'
import { changePct, defaultPeriod, lossTotal, orderCostTotal, staffRows, staleStockCost, type ControlReport } from './controlReportModel'

describe('control report display', () => {
  it('compares periods without dividing by zero', () => {
    expect(changePct(15000, 10000)).toBe(50)
    expect(changePct(5000, 10000)).toBe(-50)
    expect(changePct(5000, 0)).toBeNull()
  })
  it('sums only real losses and frozen stock', () => {
    expect(lossTotal([{ margin: -500 }, { margin: 300 }, { margin: -200 }] as any)).toBe(-700)
    expect(staleStockCost([{ stock_cost: 1000 }, { stock_cost: 250 }] as any)).toBe(1250)
  })
  it('starts from the first day of the Kyiv month', () => {
    expect(defaultPeriod(new Date('2026-11-16T10:00:00Z'))).toEqual({ from: '2026-11-01', to: '2026-11-16' })
    expect(defaultPeriod(new Date('2026-11-30T23:30:00Z'))).toEqual({ from: '2026-12-01', to: '2026-12-01' })
  })
})

describe('control report: staff and running out', () => {
  const staff = (id: string | null, revenue: number) => ({ employee_id: id, employee: id, receipts: 1, revenue, discounts: 0, profit: 0, profit_known_revenue: 0, average_receipt: revenue, below_cost_lines: 0 })
  it('adds each employee previous revenue and share of the period', () => {
    const report = { staff: [staff('a', 7500), staff(null, 2500)], staff_previous: [staff('a', 5000)] } as unknown as ControlReport
    expect(staffRows(report).map(row => [row.employee_id, row.previous_revenue, row.share_pct])).toEqual([['a', 5000, 75], [null, 0, 25]])
    expect(staffRows({} as ControlReport)).toEqual([])
  })
  it('sums the order cost of the running-out list', () => {
    expect(orderCostTotal([{ order_cost: 100 }, { order_cost: 250 }] as any)).toBe(350)
  })
})
