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

  it('reuses exact article and normalized exact name but keeps a similar product separate', () => {
    const bySku = catalog.upsertProduct({
      id: 'existing-by-sku',
      sku: 'SKU-EXACT',
      name: 'Підшипник маточини передній',
      qty_on_hand: 0,
      purchase_price: 1000,
      retail_price: 1500,
    })
    const byName = catalog.upsertProduct({
      id: 'existing-by-name',
      sku: 'OIL-530',
      name: 'Олива ELF 5W-30',
      qty_on_hand: 0,
      purchase_price: 1000,
      retail_price: 1500,
    })

    const result = supply.createInvoiceFromAiRows({
      rows: [
        { name: 'Підшипник з фото накладної', sku: 'SKU-EXACT', qty: 1, purchase_price_uah: 200 },
        { name: 'олива elf 5w 30', qty: 2, purchase_price_uah: 300 },
        { name: 'Олива ELF 5W-40', qty: 3, purchase_price_uah: 400 },
      ],
    })

    expect(result.matched).toBe(2)
    expect(result.created).toBe(1)
    expect(result.invoice.items.some((item: any) => item.product_id === bySku.id)).toBe(true)
    expect(result.invoice.items.some((item: any) => item.product_id === byName.id)).toBe(true)
    expect(catalog.findBySku('OIL-530')?.name).toBe('Олива ELF 5W-30')
    expect(result.unresolved[0]?.name).toBe('Олива ELF 5W-40')
  })

  it('uses our matched product card and calculates new rows by folder and markup grid', () => {
    const category = catalog.createCategory('Колодки')
    catalog.updateSettings({
      markup_rules: [{ minPrice: 0, maxPrice: 999999999, markupPct: 50 }],
      price_rounding_enabled: true,
      price_rounding_step: 500,
      price_rounding_dir: 'up',
    })
    const existing = catalog.upsertProduct({
      id: 'existing-with-own-barcode',
      sku: 'OUR-ARTICLE',
      name: 'Наша точна назва',
      barcode: '4820999999999',
      category_id: category.id,
      qty_on_hand: 0,
      purchase_price: 5000,
      retail_price: 7000,
    })

    const result = supply.createInvoiceFromAiRows({
      rows: [
        { name: 'Інша назва з фото', sku: 'OTHER', barcode: '4820999999999', qty: 2, purchase_price_uah: 101 },
        { name: 'Колодки передні нові', sku: 'NEW-PADS', category_name: 'Гальмівні колодки', qty: 3, purchase_price_uah: 101 },
      ],
    })

    const matchedDraft = result.draft_items.find((item: any) => item.product_id === existing.id) as any
    expect(matchedDraft.product_name).toBe('Наша точна назва')
    expect(matchedDraft.sku).toBe('OUR-ARTICLE')
    expect(matchedDraft.barcode).toBe('4820999999999')
    expect(matchedDraft.retail_price).toBe(15500)

    const created = catalog.findBySku('NEW-PADS')
    expect(created?.barcode).toBeNull()
    expect(created?.category_id).toBe(category.id)
    expect(created?.retail_price).toBe(15500)
    expect(result.unresolved[0]).toMatchObject({ needs_barcode: true, needs_category: false })
  })
})
