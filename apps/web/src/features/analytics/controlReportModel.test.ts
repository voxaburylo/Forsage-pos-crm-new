import { describe, expect, it } from 'vitest'
import { changePct, defaultPeriod, lossTotal, staleStockCost } from './controlReportModel'

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
