import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

describe('reference snapshot and delta application', () => {
  let root = ''
  let db: LocalDatabase
  let sync: LocalSyncRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-reference-delta-'))
    db = new LocalDatabase(root)
    sync = new LocalSyncRepository(db)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-reference-delta-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reconciles a full reference snapshot in batches and accepts ordinary tombstones', async () => {
    const product = {
      id: 'reference-product',
      sku: 'REFERENCE-SKU',
      name: 'Reference product',
      retail_price: 100,
      qty_on_hand: 1,
    }
    await sync.applyPullChangesChunked({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: '2026-08-01T12:00:00.000Z',
      references_included: true,
      products: [product],
      product_barcodes: [{ id: 'barcode-old', product_id: product.id, barcode: '111' }],
    })

    await sync.applyPullChangesChunked({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: '2026-08-01T12:00:01.000Z',
      references_included: true,
      products: [product],
      product_barcodes: [{ id: 'barcode-new', product_id: product.id, barcode: '222' }],
    })

    const afterSnapshot = db.prepare('SELECT id, barcode FROM product_barcodes WHERE product_id = ? ORDER BY barcode')
      .all(product.id) as Array<{ id: string; barcode: string }>
    expect(afterSnapshot).toEqual([{ id: 'barcode-new', barcode: '222' }])

    await sync.applyPullChangesChunked({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: '2026-08-01T12:00:02.000Z',
      deleted_product_barcode_ids: ['barcode-new'],
    })
    expect(db.prepare('SELECT id FROM product_barcodes WHERE id = ?').get('barcode-new')).toBeUndefined()
  })
})
