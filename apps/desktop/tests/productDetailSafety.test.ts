import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalWarehouseRepository } from '../src/repositories/warehouseRepository'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'
import { isLanProxyChannel } from '../src/lan/localNetwork'

describe('product detail: local cross-number delta and reserve retry', () => {
  let root: string, db: LocalDatabase, catalog: LocalCatalogRepository
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-detail-safety-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    for (const [id, sku] of [['a', 'W67/1'], ['b', 'OC195'], ['c', 'W811/80']]) {
      catalog.saveProduct({ id, sku, name: 'Filter ' + sku, barcode: id + '12345',
        qty_on_hand: 5, retail_price: 12000, purchase_price: 8000, photo_url: 'local-photo',
        additional_barcodes: [id + '67890'], notes: 'Keep notes', specs: { size: '10' } })
    }
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-detail-safety-')) rmSync(root, { recursive: true, force: true })
  })
  const count = (db: LocalDatabase, table: string) => (db.prepare('SELECT COUNT(*) n FROM ' + table).get() as { n: number }).n

  it('changes only numbers; retains stock, prices, attributes and other numbers/ids', () => {
    const before = catalog.findById('a')!
    const movements = count(db, 'inventory_movements')
    const first = catalog.changeCrossNumbers('a', { add: ['OC195'], source: 'Supplier catalog' })
    const second = catalog.changeCrossNumbers('a', { add: ['PH6607', 'oc 195', 'PH-6607'] })
    expect(second).toHaveLength(2)
    expect(second[0]).toEqual(first[0])
    expect(catalog.findById('a')).toMatchObject({ ...before, updated_at: expect.any(String) })
    expect(catalog.findById('a')!.updated_at).not.toBe(before.updated_at)
    expect(count(db, 'inventory_movements')).toBe(movements)
    expect(count(db, 'product_barcodes')).toBe(6)
    expect(catalog.listAnalogs('a').map(row => row.id)).toEqual(['b'])
    expect(catalog.listAnalogs('b').map(row => row.id)).toEqual(['a'])
    expect(catalog.listAnalogs('c')).toEqual([])
  })
  it('retries add after restart without duplicates, removes only the selected product number', () => {
    const rows = catalog.changeCrossNumbers('a', { add: ['OC195'] })
    db.close(); db = new LocalDatabase(root); catalog = new LocalCatalogRepository(db)
    expect(catalog.changeCrossNumbers('a', { add: ['OC195'] })).toEqual(rows)
    expect(() => catalog.changeCrossNumbers('b', { removeId: rows[0].id })).toThrow('Оновіть картку')
    expect(catalog.listCrossNumbers('a')).toEqual(rows)
    expect(catalog.changeCrossNumbers('a', { removeId: rows[0].id })).toEqual([])
    expect(catalog.changeCrossNumbers('a', { removeId: rows[0].id })).toEqual([])
    expect(catalog.changeCrossNumbers('a', { add: ['OC195'] })[0].id).toBe(rows[0].id)
  })
  it('atomically rolls back cross edits if the outbox update fails', () => {
    const before = catalog.findById('a')!
    db.exec("CREATE TRIGGER fail_detail_outbox BEFORE UPDATE ON sync_outbox BEGIN SELECT RAISE(ABORT, 'outbox failed'); END")
    expect(() => catalog.changeCrossNumbers('a', { add: ['OC195'] })).toThrow('outbox failed')
    expect(catalog.listCrossNumbers('a')).toEqual([])
    expect(catalog.findById('a')).toEqual(before)
  })
  it('queues the complete list and keeps a stale editor from overwriting the change', () => {
    const before = catalog.findById('a')!
    catalog.changeCrossNumbers('a', { add: ['OC195', 'PH6607'] })
    const row = db.prepare("SELECT payload_json FROM sync_outbox WHERE aggregate_id = 'a' ORDER BY sequence DESC LIMIT 1").get() as { payload_json: string }
    expect(JSON.parse(row.payload_json)).toMatchObject({
      cross_numbers: ['OC195', 'PH6607'], qty_on_hand: 5, retail_price: 12000,
      notes: 'Keep notes', photo_url: 'local-photo', specs: { size: '10' }, additional_barcodes: ['a67890'],
    })
    expect(() => catalog.saveProduct({ id: 'a', sku: before.sku, name: before.name, expected_updated_at: before.updated_at })).toThrow('LOCAL_PRODUCT_STALE')
  })
  it.each([[], [''], ['!!!'], ['a'.repeat(121)], Array(1001).fill('OC195')])('rejects invalid number input atomically', add => {
    expect(() => catalog.changeCrossNumbers('a', { add })).toThrow()
    expect(catalog.listCrossNumbers('a')).toEqual([])
  })
  it('does not edit an absent, archived or foreign-tenant product', () => {
    expect(() => catalog.changeCrossNumbers('missing', { add: ['OC195'] })).toThrow('Товар не знайдено')
    expect(() => catalog.changeCrossNumbers('a', { add: ['OC195'] }, 'foreign')).toThrow('Товар не знайдено')
    db.prepare("UPDATE products SET deleted_at = 'archived' WHERE id = 'a'").run()
    expect(() => catalog.changeCrossNumbers('a', { add: ['OC195'] })).toThrow('Товар не знайдено')
  })
  it('reserves once after lost reply/restart with a stable duration request', () => {
    const input = { product_id: 'a', qty: 1.125, duration_days: 3, operation_id: 'reserve-retry' }
    const first = new LocalWarehouseRepository(db).createManualReserve(input)
    db.close(); db = new LocalDatabase(root); catalog = new LocalCatalogRepository(db)
    const replay = new LocalWarehouseRepository(db).createManualReserve(input)
    expect(replay).toEqual(first)
    expect(count(db, 'stock_reserves')).toBe(1)
    expect(catalog.findById('a')).toMatchObject({ qty_on_hand: 5, qty_available: 3.875, qty_reserved: 1.125 })
    const row = db.prepare('SELECT expires_at FROM stock_reserves WHERE tenant_id = ?').get(DEFAULT_TENANT_ID) as { expires_at: string }
    expect(Date.parse(row.expires_at) - Date.now()).toBeGreaterThan(2.9 * 86400000)
  })
  it.each([0, -1, 1.5, 366, NaN])('rejects invalid reserve duration %s', duration_days => {
    expect(() => new LocalWarehouseRepository(db).createManualReserve({ product_id: 'a', qty: 1, duration_days })).toThrow()
    expect(count(db, 'stock_reserves')).toBe(0)
  })
  it('does not accept two different expiry instructions', () => {
    expect(() => new LocalWarehouseRepository(db).createManualReserve({ product_id: 'a', qty: 1, duration_days: 3, expires_at: '2099-01-01' })).toThrow()
  })
  it('uses current stock and rejects excess reserve', () => {
    const warehouse = new LocalWarehouseRepository(db)
    warehouse.createManualReserve({ product_id: 'a', qty: 4, duration_days: 3 })
    expect(() => warehouse.createManualReserve({ product_id: 'a', qty: 2, duration_days: 3 })).toThrow('Недостатньо')
    expect(count(db, 'stock_reserves')).toBe(1)
  })
  it('authorizes editors and routes changes to the main PC in LAN mode', () => {
    const channel = 'desktop:catalog:change-cross-numbers'
    for (const role of ['owner', 'admin', 'cashier', 'manager', 'storekeeper']) expect(isDesktopChannelAllowed(channel, role)).toBe(true)
    for (const role of ['sto_viewer', 'tire_worker', 'unknown']) expect(isDesktopChannelAllowed(channel, role)).toBe(false)
    expect(isLanProxyChannel(channel)).toBe(true)
  })
})
