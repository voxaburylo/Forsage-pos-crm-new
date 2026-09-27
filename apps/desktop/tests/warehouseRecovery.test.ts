import { randomUUID } from 'node:crypto'
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

describe('warehouse lost-reply resolution and late-write fence', () => {
  let root: string, db: LocalDatabase, warehouse: LocalWarehouseRepository, productId: string, userId: string
  const kinds = ['reserve', 'movement', 'consumption'] as const
  type Kind = typeof kinds[number]
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-warehouse-recovery-'))
    db = new LocalDatabase(root); warehouse = new LocalWarehouseRepository(db)
    productId = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: randomUUID(), name: 'Test oil', qty_on_hand: 8, purchase_price: 123, storage_bin: 'A' }).id
    userId = randomUUID()
    const now = new Date().toISOString()
    db.prepare("INSERT INTO staff_users (id, tenant_id, full_name, role, is_active, created_at, updated_at) VALUES (?, ?, 'Fixture', 'manager', 1, ?, ?)")
      .run(userId, DEFAULT_TENANT_ID, now, now)
  })
  afterEach(() => {
    db?.close()
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-warehouse-recovery-')) rmSync(root, { recursive: true, force: true })
  })
  function write(kind: Kind, id: string) {
    if (kind === 'reserve') return warehouse.createManualReserve({ operation_id: id, user_id: userId, product_id: productId, qty: 1.125, duration_days: 3 })
    if (kind === 'movement') return warehouse.createMovement({ operation_id: id, user_id: userId, product_id: productId, qty: 8, from_bin: 'A', to_bin: 'B' })
    return warehouse.createConsumption({ operation_id: id, user_id: userId, employee_id: userId, items: [{ product_id: productId, qty: 1.125 }] })
  }
  const stock = () => db.prepare('SELECT qty_on_hand, storage_bin FROM products WHERE id = ?').get(productId)
  for (const kind of kinds) {
    it(kind + ': commit lost reply is recovered after restart without a second document', () => {
      const id = randomUUID(), saved = write(kind, id), before = stock()
      const outbox = db.prepare('SELECT COUNT(*) n FROM sync_outbox').get()
      db.close(); db = new LocalDatabase(root); warehouse = new LocalWarehouseRepository(db)
      expect(warehouse.resolveOperation(kind, id, userId)).toEqual({ status: 'committed', result: saved })
      expect(warehouse.resolveOperation(kind, id, userId)).toEqual({ status: 'committed', result: saved })
      expect(write(kind, id)).toEqual(saved)
      expect(stock()).toEqual(before)
      expect(db.prepare('SELECT COUNT(*) n FROM sync_outbox').get()).toEqual(outbox)
    })
    it(kind + ': missing receipt is fenced before a delayed original write can arrive', () => {
      const id = randomUUID(), before = stock()
      expect(warehouse.resolveOperation(kind, id, userId)).toEqual({ status: 'not_committed' })
      db.close(); db = new LocalDatabase(root); warehouse = new LocalWarehouseRepository(db)
      expect(() => write(kind, id)).toThrow('закрито без проведення')
      expect(stock()).toEqual(before)
      expect(warehouse.resolveOperation(kind, id, userId)).toEqual({ status: 'not_committed' })
      expect(write(kind, randomUUID())).toHaveProperty('id')
    })
    it(kind + ': another employee cannot claim a saved operation', () => {
      const id = randomUUID(); write(kind, id)
      expect(() => warehouse.resolveOperation(kind, id, randomUUID())).toThrow('іншому працівнику')
    })
    it(kind + ': cancellation markers are employee-bound', () => {
      const id = randomUUID(); warehouse.resolveOperation(kind, id, userId)
      expect(() => warehouse.resolveOperation(kind, id, randomUUID())).toThrow('іншому працівнику')
    })
  }
  it('failed business transaction can be fenced with no partial stock, journal or writeoff', () => {
    db.exec("CREATE TRIGGER fail_consumption BEFORE INSERT ON internal_consumptions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
    const id = randomUUID()
    expect(() => write('consumption', id)).toThrow('fixture failure')
    expect(warehouse.resolveOperation('consumption', id, userId)).toEqual({ status: 'not_committed' })
    db.exec('DROP TRIGGER fail_consumption')
    expect(() => write('consumption', id)).toThrow('закрито без проведення')
    expect(stock()).toMatchObject({ qty_on_hand: 8 })
    expect(db.prepare('SELECT COUNT(*) n FROM writeoffs').get()).toEqual({ n: 0 })
  })
  it('cannot report absence when the durable fence failed to persist', () => {
    db.exec("CREATE TRIGGER fail_fence BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'mutation:%' BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
    expect(() => warehouse.resolveOperation('reserve', randomUUID(), userId)).toThrow('disk failure')
    expect(stock()).toMatchObject({ qty_on_hand: 8 })
  })
  it('does not reveal a receipt from a different tenant', () => {
    const id = randomUUID(); write('reserve', id)
    expect(warehouse.resolveOperation('reserve', id, userId, randomUUID())).toEqual({ status: 'not_committed' })
    expect(warehouse.resolveOperation('reserve', id, userId).status).toBe('committed')
  })
  it('corrupt receipt fails closed, without clearing it', () => {
    const id = randomUUID(), key = 'mutation:reserve:' + DEFAULT_TENANT_ID + ':' + id
    db.prepare('INSERT INTO app_meta(key,value_json,updated_at) VALUES (?, ?, ?)').run(key, '{broken', new Date().toISOString())
    expect(() => warehouse.resolveOperation('reserve', id, userId)).toThrow()
    expect(db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(key)).toEqual({ value_json: '{broken' })
  })
  it.each(['', ' ', 'x'.repeat(201)])('rejects invalid operation ID without creating a fence: %s', id => {
    expect(() => warehouse.resolveOperation('reserve', id, userId)).toThrow('Некоректна')
  })
  it('uses main-PC LAN routing and does not widen consumption rights', () => {
    for (const kind of kinds) {
      const channel = 'desktop:warehouse:resolve-' + kind
      expect(isLanProxyChannel(channel)).toBe(true)
      expect(isDesktopChannelAllowed(channel, 'manager')).toBe(true)
      expect(isDesktopChannelAllowed(channel, 'cashier')).toBe(false)
    }
    expect(isDesktopChannelAllowed('desktop:warehouse:resolve-consumption', 'storekeeper')).toBe(false)
    expect(() => warehouse.resolveOperation('invalid' as Kind, randomUUID(), userId)).toThrow('Некоректна')
  })
})
