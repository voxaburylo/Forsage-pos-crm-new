import { describe, expect, it } from 'vitest'
import { abcDateRange, parseAbcRows } from './abcData'
import { businessDateRangeUtc } from '@/lib/businessDate'

const row = { id: 'p', sku: 'SKU', name: 'Фільтр', currentStock: 0, soldQty: 1, profit: 100, abc_class: 'A', cumulative_pct: 100 }
describe('ABC response validation', () => {
  it('accepts an empty report', () => expect(parseAbcRows([])).toEqual([]))
  it('accepts fractional quantities and negative profit/stock from real operations', () => {
    expect(parseAbcRows([{ ...row, currentStock: -1, soldQty: -.125, profit: -123, abc_class: 'Z' }])[0].soldQty).toBe(-.125)
  })
  it.each(['id', 'sku', 'name', 'currentStock', 'soldQty', 'profit', 'abc_class', 'cumulative_pct'])('rejects a missing %s', key => {
    const partial: Record<string, unknown> = { ...row }; delete partial[key]
    expect(() => parseAbcRows([partial])).toThrow('неповні')
  })
  it.each([NaN, Infinity, '100', null])('rejects invalid money %j', profit => expect(() => parseAbcRows([{ ...row, profit }])).toThrow())
  it('rejects duplicate rows and unknown classes', () => {
    expect(() => parseAbcRows([row, row])).toThrow()
    expect(() => parseAbcRows([{ ...row, abc_class: 'Q' }])).toThrow()
  })
  it('rejects malformed payloads instead of treating them as an empty report', () => {
    for (const value of [undefined, null, {}, { data: [row] }]) expect(() => parseAbcRows(value)).toThrow()
  })
})
describe('ABC local and web period agreement', () => {
  it('uses exactly 90 days, including today', () => {
    expect(abcDateRange('90', '2026-10-03')).toEqual({ startDate: '2026-07-06', endDate: '2026-10-03' })
  })
  it.each([
    ['2026-03-29','2026-03-28T22:00:00.000Z','2026-03-29T20:59:59.999Z'],
    ['2026-10-25','2026-10-24T21:00:00.000Z','2026-10-25T21:59:59.999Z'],
  ])('uses a whole calendar day at the %s DST transition', (today, from, to) => {
    const range = abcDateRange('1', today)
    expect(range).toEqual({ startDate: today, endDate: today })
    expect(businessDateRangeUtc(range.startDate, range.endDate)).toEqual({ from, to })
  })
  it.each(['0','-1','1.5','90oops','','NaN','Infinity','3661'])('rejects invalid days %s', value => expect(() => abcDateRange(value)).toThrow())
})
