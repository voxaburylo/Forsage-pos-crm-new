import { describe, expect, it } from 'vitest'
import { filterOrders, orderDebt, orderGroup, orderPaymentState, pickupOverdue } from './orderViewModel'

const order = (over: Record<string, unknown>) => ({ id: 'o', status: 'new', total_amount: 10000, total_paid: 0, pickup_deadline_at: null, ...over }) as any

describe('web order view', () => {
  it('groups statuses as the shop sees them', () => {
    expect(orderGroup('ordered')).toBe('active')
    expect(orderGroup('arrived')).toBe('ready'); expect(orderGroup('ready')).toBe('ready'); expect(orderGroup('no_answer')).toBe('ready')
    expect(orderGroup('completed')).toBe('done'); expect(orderGroup('canceled')).toBe('done')
    expect(filterOrders([order({ status: 'ready' }), order({ status: 'new' })], 'ready')).toHaveLength(1)
    expect(filterOrders([order({ status: 'ready' }), order({ status: 'new' })], 'all')).toHaveLength(2)
  })
  it('shows debt and payment state without negative amounts', () => {
    expect(orderDebt(order({ total_paid: 4000 }))).toBe(6000)
    expect(orderDebt(order({ total_paid: 12000 }))).toBe(0)
    expect(orderDebt(order({ status: 'canceled' }))).toBe(0)
    expect(orderPaymentState(order({}))).toBe('unpaid')
    expect(orderPaymentState(order({ total_paid: 1 }))).toBe('partial')
    expect(orderPaymentState(order({ total_paid: 10000 }))).toBe('paid')
  })
  it('flags an overdue pickup only while the order is still open', () => {
    const now = Date.parse('2026-11-16T12:00:00Z')
    expect(pickupOverdue(order({ status: 'ready', pickup_deadline_at: '2026-11-15T12:00:00Z' }), now)).toBe(true)
    expect(pickupOverdue(order({ status: 'completed', pickup_deadline_at: '2026-11-15T12:00:00Z' }), now)).toBe(false)
    expect(pickupOverdue(order({ status: 'ready', pickup_deadline_at: '2026-11-17T12:00:00Z' }), now)).toBe(false)
  })
})
