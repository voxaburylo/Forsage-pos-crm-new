import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalSupplierCatalogRepository } from '../src/repositories/supplierCatalogRepository'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { catalogQuantity, addCatalogQuantity, catalogPriceKopecks, catalogPriceFromHryvnia } from '../src/lib/supplierCatalogNumbers'

let root = '', db: LocalDatabase, repo: LocalSupplierCatalogRepository
const row = (fields: Record<string, unknown> = {}): any => ({
  source_row: 7, sku: 'TEST', name: 'Test product', qty: '2', price_kopecks: 12000, ...fields,
})
const snap = () => ['supplier_price_items', 'supplier_price_imports', 'sync_outbox', 'products', 'app_meta']
  .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all())
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-catalog-numbers-'))
  db = new LocalDatabase(root)
  repo = new LocalSupplierCatalogRepository(db)
  repo.create(row({ sku: 'OLD', name: 'Existing price', qty: '5' }))
})
afterEach(() => {
  db.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-catalog-numbers-'))
    rmSync(root, { recursive: true, force: true })
})
it('keeps desktop, renderer and server numeric rules identical', () => {
  const source = (file: string) => readFileSync(path.resolve(__dirname, file), 'utf8').replace(/\r\n/g, '\n')
  expect(source('../src/lib/supplierCatalogNumbers.ts')).toBe(source('../../web/src/lib/supplierCatalogNumbers.ts'))
  expect(source('../src/lib/supplierCatalogNumbers.ts')).toBe(source('../../../server/src/lib/supplierCatalogNumbers.ts'))
})
it.each([
  ['0,001', '0.001'], ['1.234', '1.234'], ['1 234,125', '1234.125'],
  ['1.234,125', '1234.125'], ['1,234.125', '1234.125'],
  ['1,234,567', '1234567'], ['1\u00a0234\u202f567,001', '1234567.001'],
  ['12.34000', '12.34'], [0.001, '0.001'], ['+1', '1'],
])('parses %s exactly as %s', (input, expected) => expect(catalogQuantity(input)).toBe(expected))
it.each([
  '', null, {}, false, [], '2 шт', '1/2', '2+3', '1,23,4', '1.23.4', '-0.1', '0x10',
  '9007199254740.999', '9007199254740.991', Infinity, 0.0001, '1,234,567.8901',
])('rejects ambiguous or unrepresentable quantity %j', input => expect(() => catalogQuantity(input)).toThrow())
it.each([
  ['1 234,56', 123456], ['1,234.56', 123456], ['1.234,56', 123456],
  ['₴ 12,30', 1230], ['12.30 грн', 1230], [1.23, 123], ['0', 0], ['21 474 836,47', 2147483647],
])('converts hryvnia %s exactly to kopecks', (input, expected) => expect(catalogPriceFromHryvnia(input)).toBe(expected))
it.each(['1,234', '12oops', '1 2', '12 USD', '1e3', '', false, '21474836.48', '12.001'])
('rejects invalid hryvnia %j', input => expect(() => catalogPriceFromHryvnia(input)).toThrow())
it('adds thousandths without floating-point accumulation and rejects overflow', () => {
  expect(addCatalogQuantity('0.1', '0.2')).toBe('0.3')
  expect(() => addCatalogQuantity('9007199254740', '1')).toThrow()
  expect(catalogPriceKopecks('00100')).toBe(100)
})
it('does not hide bad legacy quantities in the list or silently add to them', () => {
  const item = repo.create(row())
  db.prepare('UPDATE supplier_price_items SET qty=? WHERE id=?').run('98bad', item.id)
  expect(repo.list({ query: 'Test product' }).data[0].qty).toBe('98bad')
  const before = snap()
  expect(() => repo.importRows('new.csv', [row()], { mode: 'add', supplier_id: null })).toThrow()
  expect(snap()).toEqual(before)
})
const invalid = [
  { qty: '2bad' }, { qty: '1 2' }, { qty: '-1' }, { qty: '0.0001' },
  { qty: true }, { qty: [] }, { qty: '1e3' }, { qty: 'Infinity' },
  { price_kopecks: -1 }, { price_kopecks: 0.5 }, { price_kopecks: NaN },
  { price_kopecks: null }, { price_kopecks: true }, { price_kopecks: 2147483648 },
]
it.each(invalid)('rejects invalid create numbers %j without writes', bad => {
  const before = snap()
  expect(() => repo.create(row(bad))).toThrow()
  expect(snap()).toEqual(before)
})
it.each(['add', 'replace'] as const)('rolls back an entire %s import with a late invalid row', mode => {
  const before = snap()
  expect(() => repo.importRows('broken.csv', [row(), row({ sku: 'BAD', name: 'Bad', qty: '98oops' })], { mode, supplier_id: null }))
    .toThrow(/7|кількість/i)
  expect(snap()).toEqual(before)
})
it.each(['add', 'replace'] as const)('rejects incomplete parsed %s batches', mode => {
  const before = snap()
  expect(() => repo.importRows('partial.csv', [row()], { mode, supplier_id: null, parse_errors: [{ row: 8, error: 'Невірна кількість' }] }))
    .toThrow(/8|ряд/i)
  expect(snap()).toEqual(before)
})
it('preserves comma thousandths, grouped quantities and integer kopecks exactly', () => {
  const first = repo.create(row({ qty: '1 234,125', price_kopecks: 2147483647 }))
  expect(first.qty).toBe('1234.125')
  expect(first.price_kopecks).toBe(2147483647)
  const next = repo.update(first.id, { qty: '0,001', price_kopecks: 0 })
  expect(next.qty).toBe('0.001')
  expect(next.price_kopecks).toBe(0)
})
it('does not reinterpret unsafe updates or remote copies', () => {
  const item = repo.create(row())
  db.prepare('UPDATE supplier_price_items SET dirty_at=NULL WHERE id=?').run(item.id)
  const before = snap()
  expect(() => repo.update(item.id, { price_kopecks: 123.5 })).toThrow()
  expect(() => repo.upsertRemoteItem({ ...item, qty: '3junk' }, tenant, '2026-10-08T12:00:00Z')).toThrow()
  expect(snap()).toEqual(before)
})
it('sums decimal quantities exactly in duplicate rows, across restart and in the copy queue', () => {
  repo.importRows('fraction.csv', [
    row({ qty: '0.1' }), row({ qty: '0.2' }), row({ qty: '0.001' }),
  ], { mode: 'replace', supplier_id: null })
  const item = repo.list({ tenant_id: tenant }).data[0]
  expect(item.qty).toBe('0.301')
  const payload = JSON.parse((db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type='supplier_catalog.imported'").get() as any).payload_json)
  expect(payload.items).toHaveLength(1)
  expect(payload.items[0].qty).toBe('0.301')
  db.close(); db = new LocalDatabase(root); repo = new LocalSupplierCatalogRepository(db)
  expect(repo.list({ tenant_id: tenant }).data[0].qty).toBe('0.301')
})
