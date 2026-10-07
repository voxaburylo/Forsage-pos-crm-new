import { afterEach, expect, it, vi } from 'vitest'
import { parseStaffRows, staffDateRange, staffExportRows, validStaffRange } from './staffData'
const good = { manager_id: 'seller', manager_name: 'Касир', sales_revenue: 10000, sales_cogs: 6000,
  orders_revenue: 0, orders_cogs: 0, total_revenue: 10000, total_cogs: 6000, gross_profit: 4000,
  salary_cost: 1000, bonus_cost: 100, advance_cost: 900, penalty_cost: 50, total_payouts: 900, net_profit: 2950 }
afterEach(() => vi.useRealTimers())
it('accepts a complete reconciled report including actual salary and payments', () => {
  expect(parseStaffRows([good])).toEqual([good])
})
it('distinguishes an empty report from missing data', () => {
  expect(parseStaffRows([])).toEqual([])
  expect(() => parseStaffRows(undefined)).toThrow('неповні')
})
it.each(Object.keys(good))('rejects a missing %s', key => {
  const row = { ...good } as Record<string, unknown>; delete row[key]
  expect(() => parseStaffRows([row])).toThrow('неповні')
})
it.each(['sales_revenue', 'total_revenue', 'total_cogs', 'gross_profit', 'total_payouts', 'net_profit'])(
  'rejects inconsistent totals at %s', key => {
    expect(() => parseStaffRows([{ ...good, [key]: Number(good[key as keyof typeof good]) + 1 }])).toThrow('неузгоджені')
  })
it.each([null, '100', Infinity, NaN, .5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid money %s', value => {
  expect(() => parseStaffRows([{ ...good, salary_cost: value }])).toThrow()
})
it('rejects duplicate employee rows', () => {
  expect(() => parseStaffRows([good, good])).toThrow()
})
it('preserves refund-only days and negative commission reversals', () => {
  const row = { ...good, sales_revenue: -10000, sales_cogs: -6000, total_revenue: -10000,
    total_cogs: -6000, gross_profit: -4000, salary_cost: 0, bonus_cost: -100, penalty_cost: 0, net_profit: -3900 }
  expect(parseStaffRows([row])[0].net_profit).toBe(-3900)
})
it('exports separately named accruals, actual payments and penalties in hryvnias', () => {
  expect(staffExportRows([good])[0]).toMatchObject({ 'Виручка після повернень, грн': 100,
    'Нараховано зарплати, грн': 10, 'Премії та сторно, грн': 1, 'Утримання, грн': .5,
    'Виплачено за вибрані дні роботи, грн': 9, 'Результат після нарахувань, грн': 29.5 })
})
it('does not export a malformed report', () => {
  expect(() => staffExportRows([{ ...good, total_payouts: 1900 }])).toThrow()
})
it('uses Kyiv dates even near a UTC month boundary', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-30T21:30:00Z'))
  expect(staffDateRange('month')).toEqual({ startDate: '2026-10-01', endDate: '2026-10-01' })
})
it('handles the existing three-month preset across a year boundary', () => {
  expect(staffDateRange('quarter', '2026-01-20')).toEqual({ startDate: '2025-11-01', endDate: '2026-01-20' })
  expect(staffDateRange('year', '2026-01-20')).toEqual({ startDate: '2026-01-01', endDate: '2026-01-20' })
})
it.each([['2026-02-30', '2026-03-01'], ['2026-10-05', '2026-10-04'], ['', '2026-10-04']])(
  'rejects invalid range %s – %s', (start, end) => expect(validStaffRange(start, end)).toBe(false))
it('accepts a leap day', () => expect(validStaffRange('2024-02-29', '2024-02-29')).toBe(true))
