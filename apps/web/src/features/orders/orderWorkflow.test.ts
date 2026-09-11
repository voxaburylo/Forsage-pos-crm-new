import { describe, expect, it } from 'vitest'
import { allowedOrderStatusTransitions, canIssueOrderFromPos, canManuallyChangeOrderStatus, isUnpricedOrder } from './orderWorkflow'

describe('order workflow', () => {
  it('keeps advances available only before pricing, including old new-status drafts', () => {
    for (const status of ['lead', 'quoted', 'new']) expect(isUnpricedOrder({ status, total_amount: 0, items: [] })).toBe(true)
    for (const status of ['ready', 'completed', 'canceled']) expect(isUnpricedOrder({ status, total_amount: 0, items: [] })).toBe(false)
    expect(isUnpricedOrder({ status: 'lead', total_amount: 1000, items: [] })).toBe(false)
    expect(isUnpricedOrder({ status: 'lead', total_amount: 0, items: [{ item_status: 'canceled', sell_price: 0 }] })).toBe(false)
    expect(isUnpricedOrder({ status: 'lead', total_amount: 0, items: [{ item_status: 'pending', sell_price: 0, core_deposit_amount: 100 }] })).toBe(false)
  })
  it('does not allow manually skipping item-driven readiness', () => {
    expect(canManuallyChangeOrderStatus('new', 'ready')).toBe(false)
    expect(canManuallyChangeOrderStatus('new', 'ordered')).toBe(true)
    expect(allowedOrderStatusTransitions('completed')).toEqual([])
  })

  it('allows issue only for a prepared order', () => {
    expect(canIssueOrderFromPos({
      status: 'ready',
      items: [{ item_status: 'arrived' }, { item_status: 'canceled' }],
    })).toBe(true)
    expect(canIssueOrderFromPos({
      status: 'ordered',
      items: [{ item_status: 'arrived' }],
    })).toBe(false)
    expect(canIssueOrderFromPos({ status: 'ready', items: [{ item_status: 'ordered' }] })).toBe(false)
  })
})
