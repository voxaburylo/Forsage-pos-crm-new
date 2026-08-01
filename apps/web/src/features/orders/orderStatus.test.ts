import { describe, expect, it } from 'vitest'
import { canDeleteDraftOrder, isCompletedOrderStatus, isTerminalOrderStatus } from './orderStatus'

describe('customer order status rules', () => {
  it('treats archived orders as immutable completed history', () => {
    expect(isTerminalOrderStatus('archived')).toBe(true)
    expect(isCompletedOrderStatus('archived')).toBe(true)
    expect(isTerminalOrderStatus('ready')).toBe(false)
  })

  it('offers deletion only for unpaid draft-like orders', () => {
    expect(canDeleteDraftOrder({ status: 'new', prepayment: 0, total_paid: 0, sale_id: null })).toBe(true)
    expect(canDeleteDraftOrder({ status: 'archived', prepayment: 0, total_paid: 0, sale_id: null })).toBe(false)
    expect(canDeleteDraftOrder({ status: 'lead', prepayment: 100, total_paid: 100, sale_id: null })).toBe(false)
  })
})
