import { describe, expect, it } from 'vitest'
import { missingSavedTabs } from './cartRecovery'

describe('receipt recovery across navigation', () => {
  const check = { idempotencyKey: 'receipt-operation-1', items: ['product'] }
  it('does not offer the current receipt again after returning to POS', () => {
    expect(missingSavedTabs([check], [check])).toEqual([])
  })
  it('keeps the live edited receipt authoritative over its older snapshot', () => {
    expect(missingSavedTabs([check], [{ ...check, items: [] }])).toEqual([])
  })
  it('still offers a genuine crash backup when memory is empty', () => {
    expect(missingSavedTabs([check], [])).toEqual([check])
  })
  it('does not conflate two distinct receipts containing the same product', () => {
    const other = { ...check, idempotencyKey: 'receipt-operation-2' }
    expect(missingSavedTabs([check, other], [check])).toEqual([other])
  })
  it('restores each operation only once, including after a partial retry', () => {
    expect(missingSavedTabs([check, check], [])).toEqual([check])
    expect(missingSavedTabs([check, check], [check])).toEqual([])
  })
})
