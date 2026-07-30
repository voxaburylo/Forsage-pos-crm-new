import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../syncService.ts', import.meta.url), 'utf8')
const productSource = source.slice(
  source.indexOf('async function applyProductUpsert'),
  source.indexOf('async function applyProductDeleted'),
)
const inventorySource = source.slice(
  source.indexOf('async function applyInventoryCompleted'),
  source.indexOf('async function applyCustomerDebtPaid'),
)
const writeoffSource = source.slice(
  source.indexOf('async function applyWriteoffCreated'),
  source.indexOf('async function applyReturnCreated'),
)

describe('offline stock sync safety', () => {
  it('preserves server stock on ordinary product edits', () => {
    expect(productSource).toContain('payload.stock_correction === true')
    expect(productSource).toContain('CASE WHEN $24::boolean THEN $11::numeric ELSE products.qty_on_hand END')
    expect(productSource).toContain('$11::numeric, $12, $13')
  })

  it('applies a writeoff as one idempotent atomic stock operation', () => {
    expect(writeoffSource).toContain('ON CONFLICT (id) DO NOTHING')
    expect(writeoffSource).toContain('RETURNING id')
    expect(writeoffSource).toContain('FOR UPDATE')
    expect(writeoffSource).toContain('SET qty_on_hand = qty_on_hand - $1')
    expect(writeoffSource).toContain("throw new AppError('INSUFFICIENT_STOCK'")
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