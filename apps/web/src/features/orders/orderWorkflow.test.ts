import { describe, expect, it } from 'vitest'
import { allowedOrderStatusTransitions, canIssueOrderFromPos, canManuallyChangeOrderStatus } from './orderWorkflow'

describe('order workflow', () => {
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
