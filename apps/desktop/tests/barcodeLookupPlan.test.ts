import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'

// 18.11.2026: saving a card took ~150 ms because SQLite chose UNIQUE(tenant_id, barcode)
// for "tenant_id=? AND product_id=?" and scanned every barcode of the shop (16.5k rows).
// The per-card lookups must use the product index; "+tenant_id" keeps the planner off the tenant index.
const sources = [
  'src/repositories/catalogRepository.ts',
  'src/repositories/productCatalogSnapshot.ts',
  'src/repositories/manualProductMerge.ts',
  'src/repositories/warehouseRepository.ts',
]

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = '' })

describe('per-product barcode lookups', () => {
  it('never filter product_barcodes by a bare tenant_id next to product_id', () => {
    for (const file of sources) {
      const text = readFileSync(path.join(__dirname, '..', file), 'utf8')
      const lookups = text.match(/FROM product_barcodes[^'`]*product_id ?= ?\?[^'`]*/g) ?? []
      for (const sql of lookups) expect(sql, file).not.toMatch(/(^|[^+])\btenant_id ?= ?\?/)
    }
  })

  it('uses the product index for the snapshot lookup on a shop-sized table', () => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-barcode-plan-'))
    const db = new LocalDatabase(root)
    try {
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT barcode FROM product_barcodes
        WHERE +tenant_id=? AND product_id=? AND deleted_at IS NULL AND is_primary=0 ORDER BY barcode`).all('t', 'p') as Array<{ detail: string }>
      expect(plan.map(row => row.detail).join(' ')).toContain('idx_product_barcodes_product')
    } finally { db.close() }
  })
})
