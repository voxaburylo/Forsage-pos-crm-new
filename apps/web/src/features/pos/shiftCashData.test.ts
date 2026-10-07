import { describe, expect, it } from 'vitest'
import { parseClosingSnapshot, parseCountedCash, parseExpectedCash } from './shiftCashData'

function sample(): any { return {
  shift: { id: 'shift', cashier_id: 'cashier', status: 'open', opening_cash: 1000 },
  cash_breakdown: { opening_cash: 1000, cash_sales: 200, cash_in: 300, cash_out: 100, cash_returns: 50, expected_amount: 1350 },
  total_sales: 1, gross_revenue: 500, refund_total: 50, total_revenue: 450,
  payment_received_total: 500, payment_refunded_total: 50, payment_net_total: 450,
  unassigned_refunds_count: 0, by_method: { cash: 200, card: 300, transfer: 0, account: 0, debt: 0 },
  refunds_by_method: { cash: 50, card: 0, transfer: 0, account: 0, debt: 0 },
  sales: [{ id: 'sale', status: 'returned', total: 500 }],
} }
describe('validated closing data', () => {
  it('accepts coherent signed cash and distinct net receipts', () => {
    const r = sample()
    expect(parseClosingSnapshot(r, 'shift', 'cashier')).toEqual(r)
    r.cash_breakdown.cash_out = 2000; r.cash_breakdown.expected_amount = -550
    expect(parseClosingSnapshot(r, 'shift', 'cashier').cash_breakdown.expected_amount).toBe(-550)
  })
  it.each([
    (r:any) => delete r.cash_breakdown,
    (r:any) => r.shift.id = 'old',
    (r:any) => r.shift.cashier_id = 'old',
    (r:any) => r.shift.status = 'closed',
    (r:any) => r.cash_breakdown.opening_cash++,
    (r:any) => r.cash_breakdown.expected_amount++,
    (r:any) => r.cash_breakdown.cash_in = NaN,
    (r:any) => r.by_method.cash = -1,
    (r:any) => r.gross_revenue++,
    (r:any) => r.refund_total++,
    (r:any) => r.payment_refunded_total++,
    (r:any) => r.payment_received_total++,
    (r:any) => r.payment_net_total++,
    (r:any) => r.sales.push({...r.sales[0]}),
    (r:any) => r.total_sales++,
  ])('blocks missing, stale or contradictory data %#', mutate => {
    const r=sample(); mutate(r)
    expect(()=>parseClosingSnapshot(r,'shift','cashier')).toThrow()
  })
  it.each([null, {}, {expected_amount:0}, {...sample().cash_breakdown,cash_out:Infinity}])('never treats incomplete cash as zero %#', value => {
    expect(()=>parseExpectedCash(value)).toThrow()
  })
  it('allows explicitly marked incomplete old noncash refunds without falsifying the cash balance',()=>{
    const r=sample(); r.unassigned_refunds_count=1
    expect(parseClosingSnapshot(r,'shift','cashier').unassigned_refunds_count).toBe(1)
  })
})
describe('counted cash input', () => {
  it.each([['0',0],['1,23',123],[' 126.5 ',12650],['90071992547409.91',Number.MAX_SAFE_INTEGER]])('parses %s exactly', (text, amount) => {
    expect(parseCountedCash(text as string)).toBe(amount)
  })
  it.each(['',' ','-1','1.234','1e3','1abc','Infinity','90071992547409.92','1,2,3'])('rejects %s', text => expect(parseCountedCash(text)).toBeNull())
})
