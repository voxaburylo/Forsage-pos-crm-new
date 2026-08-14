import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'

describe('AI invoice import into local supply draft', () => {
  let root = ''
  let db: LocalDatabase
  let catalog: LocalCatalogRepository
  let supply: LocalSupplyRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-ai-invoice-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    supply = new LocalSupplyRepository(db)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-ai-invoice-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('matches an existing barcode and creates unknown rows without barcode or category', () => {
    const existing = catalog.upsertProduct({
      id: 'existing-ai-product',
      sku: 'EXISTING-1',
      name: 'Фільтр масляний',
      barcode: '4820000000011',
      qty_on_hand: 0,
      purchase_price: 1000,
      retail_price: 1500,
    })

    const result = supply.createInvoiceFromAiRows({
      supplier_name: 'Новий постачальник',
      rows: [
        { name: 'Фільтр масляний', barcode: '4820000000011', qty: 3, purchase_price_uah: '125,50' },
        { name: 'Колодки гальмівні', sku: 'BRAKE-NEW', qty: 2, purchase_price_uah: 300 },
      ],
    })

    expect(result.matched).toBe(1)
    expect(result.created).toBe(1)
    expect(result.unresolved).toHaveLength(1)
    expect(result.invoice.status).toBe('draft')
    expect(result.invoice.items).toHaveLength(2)
    expect(result.invoice.items.find((item: any) => item.product_id === existing.id)?.purchase_price).toBe(12550)
    const created = catalog.findBySku('BRAKE-NEW')
    expect(created?.barcode).toBeNull()
    expect(created?.category_id).toBeNull()
    expect(result.invoice.items.find((item: any) => item.product_id === created?.id)?.qty).toBe(2)
  })
})