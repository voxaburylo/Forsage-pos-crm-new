import { describe, expect, it } from 'vitest'
import { aggregatePeriod, INCOMPLETE_PERIOD, type PeriodSnapshot } from './periodReport.js'

const at = '2026-10-11T09:00:00Z'
function fixture(cost = 101, quantity = 1, total = 200): PeriodSnapshot {
  return {
    sales: [{ id: 'sale', total, selected: true, sale_number: 'test', status: 'completed', completed_at: at,
      payment_method: 'cash', cash_amount: total, card_amount: null, transfer_amount: null,
      debt_amount: null, is_debt: false, customer_id: null, customer: null }],
    lines: [{ id: 'line', sale_id: 'sale', qty: quantity, total, cost }],
    returns: [], refundLines: [], orders: [], payments: [],
  }
}
function addRefund(data: PeriodSnapshot, id: string, quantity: number, amount: number, stockAction = 'return_to_stock') {
  data.returns.push({ id, sale_id: 'sale', created_at: at, amount, stock_action: stockAction })
  data.refundLines.push({ id, return_id: id, sale_item_id: 'line', quantity, total_kopecks: amount })
}
const report = (data: PeriodSnapshot) => aggregatePeriod(data, '2026-10-11', '2026-10-11')

describe('period report cost rounding', () => {
  it('does not invent profit after two half-quantity full refunds', () => {
    const data = fixture()
    addRefund(data, 'first', .5, 100)
    addRefund(data, 'second', .5, 100)
    expect(report(data)).toMatchObject({ net_revenue: 0, profit: 0 })
  })
  it('gives the same final cost for a single return or one thousand partial returns', () => {
    const whole = fixture(101, 1, 1000), split = fixture(101, 1, 1000)
    addRefund(whole, 'all', 1, 1000)
    for (let i = 0; i < 1000; i++) addRefund(split, String(i), .001, 1)
    expect(report(split).profit).toBe(report(whole).profit)
    expect(report(split).profit).toBe(0)
  })
  it('rounds after aggregating sale lines instead of losing fractional costs', () => {
    const data = fixture(1, .4, 2)
    data.sales[0].total = 4
    data.sales[0].cash_amount = 4
    data.lines.push({ ...data.lines[0], id: 'another-line' })
    expect(report(data).profit).toBe(3)
  })
  it('rounds once across receipts rather than rounding each receipt', () => {
    const data = fixture(1, .5, 2)
    data.sales.push({ ...data.sales[0], id: 'another-sale' })
    data.lines.push({ ...data.lines[0], id: 'another-line', sale_id: 'another-sale' })
    expect(report(data).profit).toBe(3)
  })
  it('preserves the existing fractional discounted-sale example', () => {
    const data = fixture(17, .3, 29)
    addRefund(data, 'partial', .1, 10)
    expect(report(data)).toMatchObject({ net_revenue: 19, profit: 16 })
  })
  it.each(['write_off', 'send_to_supplier'])('never restores cost for %s', action => {
    const data = fixture()
    addRefund(data, 'first', .5, 100, action)
    addRefund(data, 'second', .5, 100, action)
    expect(report(data)).toMatchObject({ net_revenue: 0, profit: -101 })
  })
  it('only restores the part actually returned to stock', () => {
    const data = fixture()
    addRefund(data, 'stock', .5, 100)
    addRefund(data, 'writeoff', .5, 100, 'write_off')
    expect(report(data)).toMatchObject({ net_revenue: 0, profit: -51 })
  })
  it('handles refund-only periods without counting the old sale again', () => {
    const data = fixture()
    data.sales[0].selected = false
    data.sales[0].completed_at = '2026-10-10T09:00:00Z'
    addRefund(data, 'first', .5, 100)
    addRefund(data, 'second', .5, 100)
    expect(report(data)).toMatchObject({ total_sales: 0, net_revenue: -200, profit: -99 })
  })
  it.each([
    [101, -.5, -50], [100, -.5, -50], [99, -.5, -49], [1, .5, 1], [1, .499, 0], [1, .501, 1],
  ])('keeps nearest-kopeck rounding with ties toward positive infinity: %s * %s', (cost, quantity, expectedCost) => {
    const data = fixture(cost, Math.abs(quantity), 2)
    if (quantity < 0) {
      data.sales[0].selected = false
      addRefund(data, 'partial', Math.abs(quantity), 2)
    }
    const result = report(data)
    expect(result.net_revenue - result.profit).toBe(expectedCost)
    expect(Number.isSafeInteger(result.profit)).toBe(true)
  })
  it('is independent of return ordering and does not alter input history', () => {
    const data = fixture()
    addRefund(data, 'first', .333, 66)
    addRefund(data, 'second', .667, 134)
    const before = structuredClone(data)
    expect(report(data).profit).toBe(0)
    expect(data).toEqual(before)
    data.returns.reverse()
    data.refundLines.reverse()
    expect(report(data).profit).toBe(0)
  })
  it('keeps precise multiplication near the safe integer boundary', () => {
    const data = fixture(Number.MAX_SAFE_INTEGER, .001, 0)
    expect(report(data).profit).toBe(-9007199254741)
  })
  it('rejects unsafe individual costs even when a full return could cancel them', () => {
    const data = fixture(Number.MAX_SAFE_INTEGER, 1.001, 0)
    addRefund(data, 'all', 1.001, 0)
    expect(() => report(data)).toThrow(INCOMPLETE_PERIOD)
  })
  it('rejects an unsafe total cost', () => {
    const data = fixture(Number.MAX_SAFE_INTEGER, 1, 0)
    data.sales.push({ ...data.sales[0], id: 'another-sale' })
    data.lines.push({ ...data.lines[0], id: 'another-line', sale_id: 'another-sale' })
    expect(() => report(data)).toThrow(INCOMPLETE_PERIOD)
  })
  it('rejects an unsafe profit even when net revenue and net cost are separately safe', () => {
    const data = fixture(Number.MAX_SAFE_INTEGER, 1, 0)
    addRefund(data, 'writeoff', 1, Number.MAX_SAFE_INTEGER, 'write_off')
    expect(() => report(data)).toThrow(INCOMPLETE_PERIOD)
  })
  it('keeps the public result JSON-compatible with integer kopecks', () => {
    const result = report(fixture(101, .5, 100))
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    expect(result.profit).toBe(49)
  })
})
