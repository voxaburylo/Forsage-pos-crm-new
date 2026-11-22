import { describe, expect, it } from 'vitest'
import { customerOrdersSummary } from './customerOrdersSummary'

const order = (over: Record<string, unknown> = {}) => ({ status: 'ordered', total_amount: 100000, discount_amount: 0, prepayment: 0, total_paid: 0, ...over })

describe('customer open orders at the till', () => {
  it('counts open orders, what is paid and what is still due', () => {
    expect(customerOrdersSummary([
      order({ prepayment: 30000, total_paid: 30000 }),
      order({ status: 'ready', total_amount: 50000, discount_amount: 5000, total_paid: 45000 }),
      order({ status: 'arrived' }),
    ])).toEqual({ count: 3, ready: 2, paid: 75000, due: 170000 })
  })
  it('never counts the prepayment twice and never shows more paid than the order costs', () => {
    expect(customerOrdersSummary([order({ prepayment: 40000, total_paid: 40000 })])).toMatchObject({ paid: 40000, due: 60000 })
    expect(customerOrdersSummary([order({ prepayment: 20000, total_paid: 0 })])).toMatchObject({ paid: 20000, due: 80000 })
    expect(customerOrdersSummary([order({ total_paid: 150000 })])).toMatchObject({ paid: 100000, due: 0 })
  })
  it('ignores closed orders and broken numbers', () => {
    expect(customerOrdersSummary([order({ status: 'completed' }), order({ status: 'canceled' }), order({ status: 'archived' })])).toEqual({ count: 0, ready: 0, paid: 0, due: 0 })
    expect(customerOrdersSummary([order({ total_amount: Number.NaN, total_paid: -5 })])).toEqual({ count: 1, ready: 0, paid: 0, due: 0 })
    expect(customerOrdersSummary([])).toEqual({ count: 0, ready: 0, paid: 0, due: 0 })
  })
})
