import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { InventoryReadGuard, inventoryHasPendingWrites, updateScanSummary } from './inventoryScanState'

const empty = { counted_products: 0, matching_products: 0, discrepancy_products: 0, price_checked_products: 0, price_mismatch_products: 0, total_expected_units: 0, total_counted_units: 0, total_products: 100 }
const item = { expected_stock: 3, counted_stock: 3, price_checked: true, observed_retail_price: null, product: { retail_price: 100 } }
describe('batched inventory scans', () => {
  it('wires completion after draining scans and checks failures before applying stock', () => {
    const source = readFileSync(new URL('./ActiveSession.tsx', import.meta.url), 'utf8')
    expect(source).toContain('inventoryHasPendingWrites(pendingRowWritesRef.current, scanQueueRunning.current, scanQueue.current.length)')
    const complete = source.slice(source.indexOf('async function completeSession()'), source.indexOf('async function copyLink()'))
    expect(complete.indexOf('await waitForPendingRowWrites()')).toBeLessThan(complete.indexOf('await inventoryApi.complete'))
    expect(complete.indexOf('scanFailuresRef.current !== scanFailuresBefore')).toBeLessThan(complete.indexOf('await inventoryApi.complete'))
    expect(source).toContain('sessionReadGuard.current.isCurrent(readToken) && pendingRowWritesRef.current === 0')
  })
  it('rejects an older response after a newer read or a saved scan', () => {
    const guard = new InventoryReadGuard()
    const oldRead = guard.begin()
    const newRead = guard.begin()
    expect(guard.isCurrent(oldRead)).toBe(false)
    expect(guard.isCurrent(newRead)).toBe(true)
    guard.invalidate()
    expect(guard.isCurrent(newRead)).toBe(false)
    expect(guard.isCurrent(guard.begin())).toBe(true)
  })
  it('counts a new grouped scan as one product and all scanned units', () => {
    expect(updateScanSummary(empty, undefined, item)).toMatchObject({ counted_products: 1, total_counted_units: 3, total_expected_units: 3, matching_products: 1, total_products: 100 })
  })
  it('does not invent an extra unit when the same reply is merged twice', () => {
    const first = updateScanSummary(empty, undefined, item)
    expect(updateScanSummary(first, item, item)).toEqual(first)
  })
  it('updates discrepancy and checked-price counters when an existing item changes', () => {
    const previous = { ...item, counted_stock: 1, price_checked: false, observed_retail_price: 120 }
    const first = updateScanSummary(empty, undefined, previous)
    expect(updateScanSummary(first, previous, item)).toMatchObject({ counted_products: 1, matching_products: 1, discrepancy_products: 0, price_checked_products: 1, price_mismatch_products: 0, total_counted_units: 3 })
  })
  it.each([[1, false, 0], [0, true, 0], [0, false, 5]] as const)('waits for pending work (%s, %s, %s)', (writes, running, queued) => {
    expect(inventoryHasPendingWrites(writes, running, queued)).toBe(true)
  })
  it('allows completion only after both queues are empty', () => {
    expect(inventoryHasPendingWrites(0, false, 0)).toBe(false)
  })
})
