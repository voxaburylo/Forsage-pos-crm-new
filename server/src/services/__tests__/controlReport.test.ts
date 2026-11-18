import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db/pg.js', () => ({ pool: { query: vi.fn() } }))
import { controlReportQuery, previousPeriod, runningOutRows } from '../controlReportService.js'

describe('control report periods', () => {
  it('compares with the same number of days right before', () => {
    expect(previousPeriod('2026-11-01', '2026-11-16')).toEqual({ from: '2026-10-16', to: '2026-10-31' })
    expect(previousPeriod('2026-11-16', '2026-11-16')).toEqual({ from: '2026-11-15', to: '2026-11-15' })
    expect(previousPeriod('2026-03-01', '2026-03-31')).toEqual({ from: '2026-01-29', to: '2026-02-28' })
  })
  it('rejects reversed or too long periods', () => {
    expect(() => previousPeriod('2026-11-16', '2026-11-01')).toThrow()
    expect(() => previousPeriod('2024-01-01', '2026-01-01')).toThrow()
  })
  it('uses safe defaults for thresholds', () => {
    expect(controlReportQuery.parse({ from: '2026-11-01', to: '2026-11-16' })).toMatchObject({ margin_pct: 10, stale_days: 90 })
    expect(controlReportQuery.safeParse({ from: '2026-11-01', to: '2026-11-16', stale_days: '3' }).success).toBe(false)
    expect(controlReportQuery.parse({ from: '2026-11-01', to: '2026-11-16' }).low_days).toBe(14)
  })
})

describe('running out list', () => {
  const row = (id: string, qty: number, sold: number, reorder = 0) => ({ id, name: id, sku: null, storage_bin: null, qty, reorder_point: reorder, sold, purchase_price: 10000 })
  it('lists items that last less than the threshold at the 30-day pace, emptiest first, with a 30-day order', () => {
    const list = runningOutRows([row('slow', 10, 3), row('fast', 2, 30), row('empty', 0, 6), row('ok', 40, 30)], 14)
    expect(list.map(item => item.id)).toEqual(['empty', 'fast'])
    expect(list.find(item => item.id === 'fast')).toMatchObject({ days_left: 2, order_qty: 28, order_cost: 280000 })
    expect(list.find(item => item.id === 'empty')).toMatchObject({ days_left: 0, order_qty: 6 })
  })
  it('includes cards at or below their reorder point even without recent sales', () => {
    const list = runningOutRows([row('min', 2, 0, 3), row('unsold', 0, 0)], 14)
    expect(list).toEqual([expect.objectContaining({ id: 'min', days_left: null, order_qty: 2 })])
  })
})
