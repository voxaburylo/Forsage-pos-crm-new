import { syncFunctionBody } from './helpers/syncSource.js'
import { describe, expect, it } from 'vitest'

const productSource = syncFunctionBody('applyProductUpsert')
const inventorySource = syncFunctionBody('applyInventoryCompleted')
const writeoffSource = syncFunctionBody('applyWriteoffCreated')

describe('offline stock sync safety', () => {
  it('preserves server stock on ordinary product edits', () => {
    expect(productSource).toContain('payload.stock_correction === true')
    expect(productSource).toContain('CASE WHEN $24::boolean THEN $11::numeric ELSE products.qty_on_hand END')
    expect(productSource).toContain('$11::numeric, $12, $13')
  })

  it('copies writeoffs atomically without replaying stock or using current cost', () => {
    expect(writeoffSource).toContain('runTransaction')
    expect(writeoffSource).toContain('pg_advisory_xact_lock')
    expect(writeoffSource).toContain('FOR UPDATE')
    expect(writeoffSource).toContain('cost_kopecks')
    expect(writeoffSource).not.toContain('UPDATE products')
    expect(writeoffSource).not.toContain('purchase_price')
  })

  it('serializes inventory completion and marks the session only after stock updates', () => {
    const sessionLock = inventorySource.indexOf('FOR UPDATE')
    const stockUpdate = inventorySource.indexOf('UPDATE products SET qty_on_hand = $1')
    const completion = inventorySource.indexOf("SET status = 'completed'")

    expect(inventorySource).toContain('ON CONFLICT (id) DO NOTHING')
    expect(sessionLock).toBeGreaterThanOrEqual(0)
    expect(sessionLock).toBeLessThan(stockUpdate)
    expect(stockUpdate).toBeLessThan(completion)
  })
})
