import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db/pg.js', () => ({ pool: { query: vi.fn() } }))
import { controlReportQuery, previousPeriod } from '../controlReportService.js'

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
  })
})
