import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'

/**
 * 26.11.2026, слово власника: «в останній накладній антифриз Вамп оприбуткувало як масло промивочне».
 * Копія бази: код постачальника «80127» (Антифриз G12+ Вамп 1л) стоїть артикулом у картці «Масло Промывочное GNL Flush 4L»;
 * шість накладних Автокомфорту поспіль рядок ішов у неї (44 шт. на картці, жодного продажу), а справжня картка антифризу
 * (без цього артикула) поповнювалась вручну. У списку вибору була лише картка з чужою назвою.
 */
describe('a supplier code that sits in a card with a completely different name', () => {
  let root: string, db: LocalDatabase, catalog: LocalCatalogRepository, supply: LocalSupplyRepository
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-ai-foreign-'))
    db = new LocalDatabase(root); catalog = new LocalCatalogRepository(db); supply = new LocalSupplyRepository(db)
  })
  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-ai-foreign-')) rmSync(root, { recursive: true, force: true })
  })
  const add = (id: string, sku: string, name: string) => catalog.upsertProduct({ id, sku, name, qty_on_hand: 1 })
  const preview = (data: Record<string, unknown>) => supply.previewInvoiceFromAiRows({ rows: [{ qty: 6, purchase_price_uah: 102.1, ...data }] })[0]

  it('is never linked by itself; cards similar by name come first, the foreign card last, and the reason names it', () => {
    add('flush', '80127', 'Масло Промывочное GNL Flush 4L')
    add('antifreeze1', 'AUTO-BCE831AA519A48C398383E67369406D3', 'Антифриз G12+ Вамп червоний Carboxy Pro (МЕП) 1л NEW')
    add('antifreeze10', '80166', 'Антифриз G12+ Вамп червоний Carboxy Pro (МЕП) 10л NEW')
    const line = preview({ name: 'Антифриз G12+ Вамп червоний Carboxy Pro (МЕП) 1л NEW', sku: '80127' })
    expect(line.status).toBe('review')
    expect(line.product_id).toBeNull()
    expect(line.candidates[0].id).toBe('antifreeze1')
    expect(line.candidates.at(-1)?.id).toBe('flush')
    // 10 л — інше фасування, у список не потрапляє.
    expect(line.candidates.map(item => item.id)).not.toContain('antifreeze10')
    expect(line.reason).toContain('«Масло Промывочное GNL Flush 4L»')
    expect(line.reason).toContain('Схожі за назвою картки — першими')
  })

  it('with no similar card the foreign card is the only choice and the row still waits for a person', () => {
    add('flush', '80127', 'Масло Промывочное GNL Flush 4L')
    const line = preview({ name: 'Антифриз G12+ Вамп червоний Carboxy Pro (МЕП) 1л NEW', sku: '80127' })
    expect(line).toMatchObject({ status: 'review', product_id: null })
    expect(line.candidates.map(item => item.id)).toEqual(['flush'])
    expect(line.reason).toContain('Виберіть картку або створіть новий товар')
  })

  it('the same goods under the same code still link by themselves', () => {
    add('flush', '80127', 'Масло Промывочное GNL Flush 4L')
    expect(preview({ name: 'Масло промывочное GNL Flush 4л', sku: '80127' })).toMatchObject({ status: 'matched', product_id: 'flush' })
  })
})
