import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'

describe('compact AI invoice review: exact identities and preflight', () => {
  let root: string, db: LocalDatabase, catalog: LocalCatalogRepository, supply: LocalSupplyRepository
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-review-safety-'))
    db = new LocalDatabase(root); catalog = new LocalCatalogRepository(db); supply = new LocalSupplyRepository(db)
  })
  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-review-safety-')) rmSync(root, { recursive: true, force: true })
  })
  const row = (extra = {}) => ({ name: 'Підшипник передній SSD', sku: '2108-001Ps', qty: 2, purchase_price_uah: 288, unit: 'шт', ...extra })
  const add = (id: string, name: string, extra = {}) => catalog.upsertProduct({ id, sku: id, name, unit: 'шт', qty_on_hand: 3, ...extra })
  const archive = (id: string) => db.prepare('UPDATE products SET deleted_at=? WHERE id=?').run('2026-09-06', id)

  it('finds an exact factory code in the name, retaining our barcode, unit and stock', () => {
    add('ours', 'Подшипник ступицы Перед ССД 2108-001Ps ВАЗ 2108', { barcode: '4820132820514' })
    const data = row()
    const changes = db.prepare('SELECT total_changes() n').get()
    expect(supply.previewInvoiceFromAiRows({ rows: [data] })[0]).toMatchObject({ status: 'matched', product_id: 'ours', validation_errors: [], candidates: [{ unit: 'шт' }] })
    expect(db.prepare('SELECT total_changes() n').get()).toEqual(changes)
    const result = supply.createInvoiceFromAiRows({ rows: [data] })
    expect(result).toMatchObject({ created: 0, matched: 1, invoice: { status: 'draft', total: 57600 } })
    expect(result.draft_items[0]).toMatchObject({ barcode: '4820132820514', qty: 2, unit: 'шт' })
    expect(catalog.findById('ours')?.qty_on_hand).toBe(3)
  })
  it('links an archived SKU only to an identical active full name, without reviving it', () => {
    const name = 'Крепление глушителя 2108-2115 (к-т 5 шт) БРТ'
    add('old', name, { sku: 'Ремкомплект 21Р', unit: 'компл' }); archive('old')
    add('active', name, { sku: '77608', unit: 'компл', barcode: '2000998783884' })
    const data = row({ name: 'Подушка крепления глушителя (компл. 5 шт) 2108 BRT', sku: 'Ремкомплект 21Р', qty: 4, unit: 'компл', purchase_price_uah: 106 })
    expect(supply.previewInvoiceFromAiRows({ rows: [data] })[0]).toMatchObject({ status: 'matched', product_id: 'active' })
    const result = supply.createInvoiceFromAiRows({ rows: [data] })
    expect(result.invoice.items[0]).toMatchObject({ product_id: 'active', qty: 4, total: 42400 })
    expect(db.prepare('SELECT deleted_at,qty_on_hand FROM products WHERE id=?').get('old')).toEqual({ deleted_at: '2026-09-06', qty_on_hand: 3 })
  })
  it('does not pick between two active replacements of an archived SKU', () => {
    const name = 'Кріплення глушника комплект 5 шт BRT'
    add('old', name, { sku: 'Ремкомплект 21Р' }); archive('old')
    add('one', name); add('two', name)
    const preview = supply.previewInvoiceFromAiRows({ rows: [row({ name, sku: 'Ремкомплект 21Р' })] })[0]
    expect(preview.status).toBe('review')
    expect(preview.candidates.map(item => item.id).sort()).toEqual(['one', 'two'])
  })
  it('shows an archived-only SKU error before saving and lets a corrected SKU proceed', () => {
    add('old', 'Інша стара картка', { sku: 'OLD-1' }); archive('old')
    expect(supply.previewInvoiceFromAiRows({ rows: [row({ sku: 'OLD-1', match_choice: 'new' })] })[0].validation_errors?.join(' ')).toContain('видаленій')
    expect(supply.previewInvoiceFromAiRows({ rows: [row({ sku: 'NEW-1', match_choice: 'new' })] })[0].validation_errors).toEqual([])
  })
  it('rejects irrelevant L390/L473 suggestions for the L620 gas spring', () => {
    add('short', 'Амортизатор багажника упор газовий Раф L-390 мм EuroEx')
    add('medium', 'Амортизатор багажника упор газовий Раф L-473 мм EuroEx')
    const preview = supply.previewInvoiceFromAiRows({ rows: [row({ name: 'Амортизатор багажника (упор газовий) Раф (L-620 мм) EuroEx', sku: 'RF-101615' })] })[0]
    expect(preview.status).toBe('new'); expect(preview.candidates).toHaveLength(0)
  })
  it('does not automatically use a conflicting exact code for a different length', () => {
    add('short', 'Амортизатор багажника L-390 мм', { sku: 'RF-101615' })
    expect(supply.previewInvoiceFromAiRows({ rows: [row({ name: 'Амортизатор багажника L-620 мм', sku: 'RF-101615' })] })[0].status).toBe('review')
  })
  it('does not suggest a rear bearing when the source explicitly says front', () => {
    add('rear', 'Подшипник ступицы задний 2108 2109 2110 SSD')
    expect(supply.previewInvoiceFromAiRows({ rows: [row({ name: 'Подшипник ступицы передний 2108 2109 2110 SSD' })] })[0].candidates).toHaveLength(0)
  })
  it('does not use a partial factory code or choose a duplicate exact part number', () => {
    add('partial', 'Фільтр W811/800')
    expect(supply.previewInvoiceFromAiRows({ rows: [row({ name: 'Фільтр', sku: 'W811/80' })] })[0].status).not.toBe('matched')
    add('one', 'Фільтр W811/80 MANN'); add('two', 'Фільтр MANN W811/80')
    expect(supply.previewInvoiceFromAiRows({ rows: [row({ name: 'Фільтр', sku: 'W811/80' })] })[0].status).toBe('review')
  })
  it.each(['шт.', 'штуки', 'pcs', 'шт (1 шт)', 'шт. (1 шт.)', 'шт (1,00 шт)'])('normalizes %s without changing quantity or price', unit => {
    add('ours', 'Підшипник 2108-001Ps')
    const data = row({ unit })
    expect(supply.previewInvoiceFromAiRows({ rows: [data] })[0].validation_errors).toEqual([])
    const result = supply.createInvoiceFromAiRows({ rows: [data] })
    expect(result.invoice.items[0]).toMatchObject({ product_id: 'ours', qty: 2, purchase_price: 28800, total: 57600 })
  })
  it.each(['компл', 'шт (5 шт)', 'упак (1 шт)', 'кг'])('shows incompatible unit %s inline and blocks the entire draft', unit => {
    add('ours', 'Підшипник 2108-001Ps')
    const data = row({ unit })
    expect(supply.previewInvoiceFromAiRows({ rows: [data] })[0].validation_errors?.join(' ')).toContain('одиниця')
    expect(() => supply.createInvoiceFromAiRows({ rows: [row({ name: 'Новий', sku: 'NEW' }), data] })).toThrow('одиниця')
    expect(catalog.findBySku('NEW')).toBeNull()
    expect(db.prepare('SELECT COUNT(*) n FROM supply_invoices').get()).toEqual({ n: 0 })
  })
  it('exposes bad quantity, purchase price and stale selection before any write', () => {
    for (const patch of [{ qty: 0 }, { purchase_price_uah: '' }, { match_choice: 'gone' }]) {
      expect(supply.previewInvoiceFromAiRows({ rows: [row(patch)] })[0].validation_errors?.length).toBeGreaterThan(0)
    }
  })
  it('blocks reused supplier (20) for two different products instead of merging them', () => {
    const rows = [row({ name: 'Мовиль 1л світлий Норма Авто Bitgum', sku: '(20)' }), row({ name: 'Мовиль 1л темний Норма Авто Bitgum', sku: '(20)' })]
    expect(supply.previewInvoiceFromAiRows({ rows }).every(item => item.validation_errors?.some(message => message.includes('повторюється')))).toBe(true)
    expect(() => supply.createInvoiceFromAiRows({ rows })).toThrow('повторюється')
    expect(db.prepare('SELECT COUNT(*) n FROM supply_invoices').get()).toEqual({ n: 0 })
  })
  it('allows a human to select another active card and keeps the original card unchanged', () => {
    add('one', 'Підшипник 2108-001Ps')
    add('other', 'Підшипник перевірений', { sku: 'OTHER' })
    const result = supply.createInvoiceFromAiRows({ rows: [row({ match_choice: 'other' })] })
    expect(result.invoice.items[0].product_id).toBe('other')
    expect(catalog.findById('one')?.qty_on_hand).toBe(3)
  })
  it('previews a committed retry as read-only without changing its original new-product choice', () => {
    const rows = [row({ name: 'Новий перевірений товар', sku: 'NEW-RETRY', match_choice: 'new', source_name: 'Новий товар з фото' })]
    const input = { operation_id: 'committed-review-retry', rows }
    const first = supply.createInvoiceFromAiRows(input)
    const before = db.prepare('SELECT total_changes() n').get()
    const preview = supply.previewInvoiceFromAiRows(input)
    expect(preview[0]).toMatchObject({ already_saved: true, validation_errors: [], product_id: first.invoice.items[0].product_id })
    expect((rows[0] as Record<string, unknown>).match_choice).toBe('new')
    expect(db.prepare('SELECT total_changes() n').get()).toEqual(before)
    expect(supply.createInvoiceFromAiRows(input).invoice.id).toBe(first.invoice.id)
    expect(() => supply.createInvoiceFromAiRows({ ...input, rows: [ { ...rows[0], qty: 99 } ] })).toThrow('інші дані')
    expect(db.prepare('SELECT COUNT(*) n FROM supply_invoices').get()).toEqual({ n: 1 })
  })
  it('automatically replaces a stale new choice with a unique existing product without changing stock', () => {
    add('ours', 'Підшипник 2108-001Ps')
    const data = row({ match_choice: 'new' })
    expect(supply.previewInvoiceFromAiRows({ rows: [data] })[0]).toMatchObject({ product_id: 'ours', validation_errors: [] })
    const result = supply.createInvoiceFromAiRows({ rows: [data] })
    expect(result).toMatchObject({ created: 0, matched: 1 })
    expect(result.invoice.items[0]).toMatchObject({ product_id: 'ours', qty: 2, purchase_price: 28800 })
    expect(catalog.findById('ours')?.qty_on_hand).toBe(3)
  })
})
