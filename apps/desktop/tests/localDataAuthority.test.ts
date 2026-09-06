import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { LocalInventoryRepository } from '../src/repositories/inventoryRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalSyncRepository } from '../src/repositories/syncRepository'
import { assertLocalDataAuthority } from '../src/security/localDataAuthority'

describe('one local source of stock', () => {
  let root: string
  let db: LocalDatabase
  let catalog: LocalCatalogRepository
  let supply: LocalSupplyRepository
  let inventory: LocalInventoryRepository
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-authority-'))
    db = LocalDatabase.open(root).database
    catalog = new LocalCatalogRepository(db)
    supply = new LocalSupplyRepository(db)
    inventory = new LocalInventoryRepository(db)
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-authority-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })
  function product() {
    return catalog.saveProduct({ id: randomUUID(), sku: randomUUID(), name: 'Перевірка локальних залишків', retail_price: 100 })
  }

  it.each(['synced', 'failed', 'discarded'] as const)('receipt, inventory and sale survive %s replies and restart', status => {
    const item = product()
    const invoice = supply.createInvoice({ items: [{ product_id: item.id, qty: 8, purchase_price: 50 }] })
    supply.postInvoice(invoice.id)
    expect(catalog.findById(item.id)?.qty_on_hand).toBe(8)
    const session = inventory.createSession({ name: 'Локальна ревізія' })
    inventory.startSession(session.id)
    inventory.countProduct(session.id, { product_id: item.id, qty: 12 })
    inventory.complete(session.id)
    expect(catalog.findById(item.id)?.qty_on_hand).toBe(12)
    const pos = new LocalPosRepository(db)
    const cashierId = randomUUID()
    const shiftId = pos.openShift({ cashier_id: cashierId })
    const checkout = { client_operation_id: randomUUID(), cashier_id: cashierId, shift_id: shiftId,
      items: [{ product_id: item.id, qty: 2, unit_price: 100 }], payments: [{ method: 'cash' as const, amount: 200 }] }
    const sale = pos.checkout(checkout)
    expect(pos.checkout(checkout).sale_id).toBe(sale.sale_id)
    expect(catalog.findById(item.id)?.qty_on_hand).toBe(10)

    const sync = new LocalSyncRepository(db)
    const operations = sync.listPending(100)
    sync.applyPushResults(operations.map(operation => ({ sequence: operation.sequence,
      operation_id: operation.operation_id, status, error: status === 'failed' ? 'Сервер недоступний' : undefined })))
    for (const channel of ['desktop:sync:apply-pull-changes', 'desktop:bootstrap:import-snapshot', 'desktop:catalog:upsert-product']) {
      expect(() => assertLocalDataAuthority(channel)).toThrow(/заборонено/)
    }
    expect(catalog.findById(item.id)?.qty_on_hand).toBe(10)
    expect(supply.getInvoice(invoice.id).items[0].qty).toBe(8)
    expect(db.prepare('SELECT counted_stock FROM inventory_items WHERE session_id = ?').get(session.id))
      .toEqual({ counted_stock: 12 })
    db.close()
    db = LocalDatabase.open(root).database
    expect(new LocalCatalogRepository(db).findById(item.id)?.qty_on_hand).toBe(10)
  })

  it('ordinary product edits and their upload record commit together', () => {
    const item = product()
    db.exec(`CREATE TRIGGER fail_outbox BEFORE INSERT ON sync_outbox
      WHEN NEW.operation_type = 'product.upsert' BEGIN SELECT RAISE(ABORT, 'test outbox failure'); END`)
    db.exec(`CREATE TRIGGER fail_outbox_update BEFORE UPDATE ON sync_outbox
      WHEN NEW.operation_type = 'product.upsert' BEGIN SELECT RAISE(ABORT, 'test outbox failure'); END`)
    expect(() => catalog.saveProduct({ ...item, name: 'Не повинно зберегтися' } as any)).toThrow('test outbox failure')
    expect(catalog.findById(item.id)?.name).toBe(item.name)
  })

  it('a failed final inventory write rolls back quantities and leaves the draft usable', () => {
    const item = product()
    const session = inventory.createSession({ name: 'Збій запису' })
    inventory.startSession(session.id)
    inventory.countProduct(session.id, { product_id: item.id, qty: 12 })
    db.exec(`CREATE TRIGGER fail_outbox BEFORE INSERT ON sync_outbox
      WHEN NEW.operation_type = 'inventory.completed' BEGIN SELECT RAISE(ABORT, 'test disk failure'); END`)
    expect(() => inventory.complete(session.id)).toThrow('test disk failure')
    expect(catalog.findById(item.id)?.qty_on_hand).toBe(0)
    expect(db.prepare('SELECT status FROM inventory_sessions WHERE id = ?').get(session.id)).toEqual({ status: 'in_progress' })
    db.exec('DROP TRIGGER fail_outbox')
    inventory.complete(session.id)
    expect(catalog.findById(item.id)?.qty_on_hand).toBe(12)
  })

  it('a failed receipt posting cannot partly increase stock', () => {
    const item = product()
    const invoice = supply.createInvoice({ items: [{ product_id: item.id, qty: 8, purchase_price: 50 }] })
    db.exec(`CREATE TRIGGER fail_outbox BEFORE INSERT ON sync_outbox
      WHEN NEW.operation_type = 'supplier_invoice.posted' BEGIN SELECT RAISE(ABORT, 'test disk failure'); END`)
    expect(() => supply.postInvoice(invoice.id)).toThrow('test disk failure')
    expect(catalog.findById(item.id)?.qty_on_hand).toBe(0)
    expect(supply.getInvoice(invoice.id).status).toBe('draft')
    db.exec('DROP TRIGGER fail_outbox')
    supply.postInvoice(invoice.id)
    expect(catalog.findById(item.id)?.qty_on_hand).toBe(8)
    expect(() => supply.postInvoice(invoice.id)).toThrow(/вже проведено/)
    expect(catalog.findById(item.id)?.qty_on_hand).toBe(8)
  })

  it('enforces the same authority in the IPC and LAN executor, before any handler', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    const body = main.slice(main.indexOf('async function executeDesktopCommand('), main.indexOf('function resolveLanSession'))
    expect(body.indexOf('assertLocalDataAuthority(channel)')).toBeLessThan(body.indexOf('listener(event, ...args)'))
    expect(main).toContain('return executeDesktopCommand(channel, listener, {} as IpcMainInvokeEvent, args, session)')
    const preload = readFileSync(new URL('../src/preload.ts', import.meta.url), 'utf8')
    expect(preload).not.toContain('applyPullChanges:')
    expect(preload).not.toContain('importSnapshot:')
    expect(preload).not.toContain('upsertProduct:')
    expect(() => assertLocalDataAuthority('desktop:inventory:complete')).not.toThrow()
    expect(() => assertLocalDataAuthority('desktop:supply:post-invoice')).not.toThrow()
    expect(() => assertLocalDataAuthority('desktop:catalog:save-product')).not.toThrow()
  })
})
