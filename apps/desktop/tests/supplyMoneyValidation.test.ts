import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'

describe('local supply money validation', () => {
  let root = ''
  let db: LocalDatabase
  let catalog: LocalCatalogRepository
  let supply: LocalSupplyRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-supply-money-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    supply = new LocalSupplyRepository(db)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-supply-money-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a barcode accidentally entered as purchase price before saving anything', () => {
    const product = catalog.upsertProduct({
      id: randomUUID(),
      sku: `PRICE-${randomUUID()}`,
      name: 'Перевірка ціни',
      qty_on_hand: 0,
      purchase_price: 100,
      retail_price: 150,
    })
    const beforeInvoices = Number(
      (db.prepare('SELECT count(*) AS count FROM supply_invoices').get() as { count: number }).count,
    )

    expect(() => supply.createInvoice({
      items: [{
        product_id: product.id,
        qty: 1,
        purchase_price: 200_099_884_047_100,
      }],
    })).toThrow(/штрихкод випадково не потрапив у поле ціни/)

    const afterInvoices = Number(
      (db.prepare('SELECT count(*) AS count FROM supply_invoices').get() as { count: number }).count,
    )
    expect(afterInvoices).toBe(beforeInvoices)
    expect(db.prepare(`
      SELECT count(*) AS count
      FROM sync_outbox
      WHERE aggregate_type = 'supply_invoice'
    `).get()).toEqual({ count: 0 })
  })
})
