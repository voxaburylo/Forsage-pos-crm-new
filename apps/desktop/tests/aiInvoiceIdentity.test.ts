import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { aiInvoiceProductName, invoiceBrand } from '../src/repositories/aiInvoiceIdentity'

describe('AI invoice identity and label names', () => {
  let root: string, db: LocalDatabase, catalog: LocalCatalogRepository, supply: LocalSupplyRepository
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-ai-identity-'))
    db = new LocalDatabase(root); catalog = new LocalCatalogRepository(db); supply = new LocalSupplyRepository(db)
  })
  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-ai-identity-')) rmSync(root, { recursive: true, force: true })
  })
  const row = (data: Record<string, unknown>) => ({ qty: 4, purchase_price_uah: 120, ...data })
  const add = (id: string, name: string, extra = {}) => catalog.upsertProduct({ id, sku: id, name, qty_on_hand: 3, ...extra })

  it('matches a separate Polo brand to the complete old name without making another card', () => {
    add('polo', 'Polo Expert (metal) 10W40 API SL/CF 1л (12)', { barcode: '4260636978889' })
    const data = row({ name: '(метал) 10W40 API SL/CF 1л (12)', brand: 'Polo Expert', sku: '62966' })
    expect(supply.previewInvoiceFromAiRows({ rows: [data] })[0]).toMatchObject({ status: 'matched', product_id: 'polo' })
    const result = supply.createInvoiceFromAiRows({ rows: [data] })
    expect(result.created).toBe(0); expect(result.matched).toBe(1)
    expect(result.invoice.items[0]).toMatchObject({ product_id: 'polo', qty: 4, purchase_price: 12000 })
    expect(catalog.findById('polo')).toMatchObject({ qty_on_hand: 3, barcode: '4260636978889' })
  })
  it('does not substitute E-TEC 1 L for 4 L and requires review of similar products', () => {
    add('etec1', 'E-TEC (metall) 10W40 ASM 1л (12)')
    const data = row({ name: '(метал) 10W40 ASM 4л (4)', brand: 'E-TEC', sku: '44397' })
    const preview = supply.previewInvoiceFromAiRows({ rows: [data] })[0]
    expect(preview.status).toBe('review'); expect(preview.product_id).toBeNull()
    expect(() => supply.createInvoiceFromAiRows({ rows: [data] })).toThrow('схожі')
    const result = supply.createInvoiceFromAiRows({ rows: [{ ...data, match_choice: 'new' }] })
    expect(result.created).toBe(1)
    expect(catalog.findBySku('44397')).toMatchObject({ name: 'Олива E-TEC 10W40 4л ASM (4) (метал)', barcode: null, qty_on_hand: 0 })
    expect(catalog.findById('etec1')?.qty_on_hand).toBe(3)
  })
  it('puts the type, brand, viscosity and volume first without deleting source specifications', () => {
    const source = '(метал) 10W40 API SL/CF 1л (12)'
    const result = supply.createInvoiceFromAiRows({ rows: [row({ name: source, brand: 'Polo Expert' })] })
    const product = catalog.findById(result.invoice.items[0].product_id)!
    expect(product.name).toBe('Олива Polo Expert 10W40 1л API SL/CF (12) (метал)')
    expect(db.prepare('SELECT notes FROM products WHERE id=?').get(product.id)).toEqual({ notes: `Назва у джерелі: ${source}\nБренд у джерелі: Polo Expert` })
    expect(aiInvoiceProductName({ name: product.name, brand: 'Polo Expert' })).toBe(product.name)
    expect(aiInvoiceProductName({ name: 'Олива ELF 5W-40' })).toBe('Олива ELF 5W-40')
  })
  it('suggests the old Mannol card for MN8206-1 but does not guess a manufacturer', () => {
    add('mannol', 'Масло трансмиссионное ATF Dexron 3 1л Аutomatic PLUS Mannol 8206', { sku: '88686', barcode: '4036021101071' })
    const data = row({ name: '8206-1 DEXRON III AUTOMATIC PLUS ATF 1L / Олива трансмісійна (автоматик)', sku: 'MN8206-1', brand: 'DEXRON' })
    const preview = supply.previewInvoiceFromAiRows({ rows: [data] })[0]
    expect(preview).toMatchObject({ status: 'review', brand: '', product_id: null })
    expect(preview.candidates.map(p => p.id)).toContain('mannol')
    const result = supply.createInvoiceFromAiRows({ rows: [{ ...data, match_choice: 'mannol' }] })
    expect(result.created).toBe(0)
    expect(result.draft_items[0]).toMatchObject({ product_id: 'mannol', barcode: '4036021101071' })
    expect(catalog.findById('mannol')?.qty_on_hand).toBe(3)
  })
  it.each([
    ['Ремінь 10 20 30', 'Ремінь 30 20 10'],
    ['Перехідник 1.5 5.1', 'Перехідник 5.1 1.5'],
    ['Фільтр W811/80', 'Фільтр W80/811'],
  ])('does not auto-match reordered technical numbers: %s', (stored, incoming) => {
    add('known', stored)
    expect(supply.previewInvoiceFromAiRows({rows:[row({name:incoming})]})[0].status).not.toBe('matched')
  })
  it('never silently chooses between conflicting SKU and barcode', () => {
    add('sku-card', 'Перший', { barcode: '4820000000011' }); add('barcode-card', 'Другий', { barcode: '4820000000028' })
    const data = row({ name: 'Розпізнаний', sku: 'sku-card', barcode: '4820000000028' })
    expect(supply.previewInvoiceFromAiRows({ rows: [data] })[0].status).toBe('review')
    expect(() => supply.createInvoiceFromAiRows({ rows: [data] })).toThrow('кільком карткам')
    expect(db.prepare('SELECT COUNT(*) n FROM supply_invoices').get()).toEqual({ n: 0 })
    expect(supply.createInvoiceFromAiRows({ rows: [{ ...data, match_choice: 'barcode-card' }] }).invoice.items[0].product_id).toBe('barcode-card')
  })
  it('does not arbitrarily pick between duplicate full names', () => {
    add('first', 'Фільтр W67/1 MANN'); add('second', 'Фільтр W67/1 MANN')
    const data = row({ name: 'Фільтр W67/1', brand: 'MANN' })
    expect(supply.previewInvoiceFromAiRows({ rows: [data] })[0].candidates).toHaveLength(2)
    expect(() => supply.createInvoiceFromAiRows({ rows: [data] })).toThrow('кільком карткам')
  })
  it.each([
    ['Рулетка 7.5м Greener', 'Рулетка 5м Greener'],
    ['Фільтр масляний MANN W811/80', 'Фільтр масляний MANN W67/1'],
  ])('never matches different sizes/models automatically: %s', (stored, incoming) => {
    add('known', stored)
    expect(supply.previewInvoiceFromAiRows({ rows: [row({ name: incoming })] })[0].status).not.toBe('matched')
  })
  it('preview makes no writes and ignores archived cards', () => {
    add('archived', 'Прихований'); db.prepare('UPDATE products SET deleted_at=? WHERE id=?').run(new Date().toISOString(), 'archived')
    const changes = db.prepare('SELECT total_changes() n').get()
    expect(supply.previewInvoiceFromAiRows({ rows: [row({ name: 'Прихований' })] })[0].status).toBe('new')
    expect(db.prepare('SELECT total_changes() n').get()).toEqual(changes)
    expect(() => supply.createInvoiceFromAiRows({ rows: [row({ name: 'Прихований', match_choice: 'archived' })] })).toThrow('видалено')
  })
  it('rolls back a preceding new product if a later row needs a choice', () => {
    add('oil', 'E-TEC (metal) 10W40 ASM 1л (12)')
    expect(() => supply.createInvoiceFromAiRows({ rows: [row({ name: 'Абсолютно новий', sku: 'NEW' }), row({ name: '(метал) 10W40 ASM 4л (4)', brand: 'E-TEC' })] })).toThrow('схожі')
    expect(catalog.findBySku('NEW')).toBeNull()
    expect(db.prepare('SELECT COUNT(*) n FROM supply_invoices').get()).toEqual({ n: 0 })
  })
  it('does not silently restore a deleted card when an AI row reuses its SKU', () => {
    add('archived', 'Стара видалена картка')
    db.prepare('UPDATE products SET deleted_at=? WHERE id=?').run(new Date().toISOString(), 'archived')
    expect(() => supply.createInvoiceFromAiRows({ rows: [row({ name: 'Інший товар', sku: 'archived' })] })).toThrow('видаленій картці')
    expect(db.prepare('SELECT qty_on_hand FROM products WHERE id=? AND deleted_at IS NOT NULL').get('archived')).toEqual({ qty_on_hand: 3 })
    expect(db.prepare('SELECT COUNT(*) n FROM supply_invoices').get()).toEqual({ n: 0 })
  })
  it('retains the chosen payload and document identity when a successful response is lost', () => {
    add('etec1', 'E-TEC (metall) 10W40 ASM 1л (12)')
    const rows = [row({ name: 'Олива E-TEC 10W40 4л ASM (4) (метал)', source_name: '(метал) 10W40 ASM 4л (4)', brand: 'E-TEC', match_choice: 'new', sku: '44397' })]
    const input = { operation_id: 'review-retry', rows }
    const first = supply.createInvoiceFromAiRows(input)
    expect(supply.createInvoiceFromAiRows(input).invoice.id).toBe(first.invoice.id)
    expect(db.prepare('SELECT COUNT(*) n FROM supply_invoices').get()).toEqual({ n: 1 })
  })
  it.each(['DEXRON', 'ATF', 'API', 'SAE', 'ACEA', 'GL-5'])('does not invent a brand from specification %s', brand => {
    expect(invoiceBrand({ brand })).toBe('')
  })
})
