import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
let root: string, db: LocalDatabase, supply: LocalSupplyRepository
const actor = randomUUID(), product = randomUUID(), other = randomUUID(), at = '2026-10-06T08:00:00Z'
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-supply-terminal-'))
  db = new LocalDatabase(root); supply = new LocalSupplyRepository(db)
  db.prepare('INSERT INTO products(id,tenant_id,sku,name,purchase_price,created_at,updated_at) VALUES(?,?,?,?,100,?,?)')
    .run(product, tenant, 'TERMINAL', 'Тест', at, at)
})
afterEach(() => {
  db.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-supply-terminal-')) rmSync(root, { recursive: true, force: true })
})
const create = () => supply.createInvoice({ items: [{ product_id: product, qty: 2, purchase_price: 100 }] })
const finish = (kind: 'cancelled' | 'deleted', invoice: any, revision = invoice.edit_revision) => kind === 'deleted'
  ? supply.deleteInvoice(invoice.id, tenant, revision) : supply.cancelInvoice(invoice.id, tenant, revision)
const queue = () => db.prepare('SELECT * FROM sync_outbox ORDER BY sequence').all() as any[]
const stock = () => (db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(product) as any).qty_on_hand
const receiptKey = (id: string) => 'supply-terminal:' + tenant + ':' + id
it.each(['cancelled', 'deleted'] as const)('keeps exact %s retry safe after restart and outbox cleanup', kind => {
  const a = create(); finish(kind, a)
  const before = db.prepare('SELECT * FROM supply_invoices').all()
  const op = queue().find(row => row.operation_type === 'supplier_invoice.' + kind)
  const payload = JSON.parse(op.payload_json)
  expect(payload).toMatchObject({ id: a.id, previous_status: 'draft', posted_by: null, posted_at: null, created_at: op.created_at })
  expect(payload.previous_invoice).toMatchObject({ created_at: a.created_at, total: 200, items: [{ id: a.items[0].id, qty: 2, total: 200 }] })
  db.exec('DELETE FROM sync_outbox')
  db.close(); db = new LocalDatabase(root); supply = new LocalSupplyRepository(db)
  finish(kind, a)
  expect(queue()).toEqual([]); expect(stock()).toBe(0)
  expect(db.prepare('SELECT * FROM supply_invoices').all()).toEqual(before)
})
it('reverses a posted invoice only once even with the old revision from a lost reply', () => {
  const a = create(), b = supply.postInvoice(a.id, { user_id: actor })
  const c = supply.cancelInvoice(a.id, tenant, b.edit_revision), before = queue()
  supply.cancelInvoice(a.id, tenant, b.edit_revision); supply.cancelInvoice(a.id, tenant, c.edit_revision)
  expect(stock()).toBe(0); expect(queue()).toEqual(before)
  expect(db.prepare("SELECT * FROM inventory_movements WHERE source_type='supply_invoice_cancel'").all()).toHaveLength(1)
  expect(JSON.parse(before.at(-1)!.payload_json)).toMatchObject({ previous_status: 'posted', posted_by: actor, posted_at: b.posted_at })
})
it.each(['cancelled', 'deleted'] as const)('rejects a stale %s request before any mutation', kind => {
  const a = create(); supply.updateInvoice(a.id, { notes: 'new version' }); const before = queue()
  expect(() => finish(kind, a)).toThrow()
  expect(queue()).toEqual(before); expect(supply.getInvoice(a.id).status).toBe('draft')
})
it.each(['cancelled', 'deleted'] as const)('rejects a different revision on %s retry', kind => {
  const a = create(); finish(kind, a); const before = queue()
  expect(() => finish(kind, a, 'f'.repeat(64))).toThrow(); expect(queue()).toEqual(before)
})
it.each(['cancelled', 'deleted'] as const)('never claims an unknown or foreign document was %s', kind => {
  const a = create()
  expect(() => finish(kind, { ...a, id: randomUUID() })).toThrow()
  expect(() => kind === 'deleted' ? supply.deleteInvoice(a.id, other, a.edit_revision) : supply.cancelInvoice(a.id, other, a.edit_revision)).toThrow()
  expect(supply.getInvoice(a.id).status).toBe('draft')
})
it.each(['cancelled', 'deleted'] as const)('cannot %s a paid invoice even if header and payment visibility were damaged', kind => {
  const a = create()
  supply.payInvoice(a.id, { amount: 50, payment_method: 'cash', fund_source: 'owner_funds', user_id: actor })
  expect(() => finish(kind, supply.getInvoice(a.id))).toThrow(/оплатою/)
  db.exec('UPDATE supply_invoices SET paid_amount=0,payment_method=NULL')
  db.prepare('UPDATE supplier_payments SET deleted_at=?,tenant_id=?').run(at, other)
  expect(() => finish(kind, supply.getInvoice(a.id))).toThrow(/оплатою/)
  expect(db.prepare('SELECT * FROM supplier_payments').all()).toHaveLength(1)
})
it.each(['posted', 'cancelled'])('cannot delete %s history', status => {
  const a = create()
  if (status === 'posted') supply.postInvoice(a.id)
  else supply.cancelInvoice(a.id)
  expect(() => supply.deleteInvoice(a.id)).toThrow()
  expect(supply.getInvoice(a.id).status).toBe(status)
})
it.each(['cancelled', 'deleted'] as const)('rejects corrupted %s receipt rather than assuming success', kind => {
  const a = create(); finish(kind, a)
  db.prepare("UPDATE app_meta SET value_json='broken' WHERE key=?").run(receiptKey(a.id))
  expect(() => finish(kind, a)).toThrow(/не підтверджений/)
})
it.each(['status', 'posted actor', 'posted time', 'line date', 'header date', 'quantity', 'deleted line'])('detects cancelled document corruption: %s', field => {
  const a = create(); finish('cancelled', a)
  const updates: Record<string, string> = {
    status: "UPDATE supply_invoices SET status='draft'",
    'posted actor': "UPDATE supply_invoices SET posted_by='" + actor + "'",
    'posted time': "UPDATE supply_invoices SET posted_at='2026-10-07'",
    'line date': "UPDATE supply_invoice_items SET created_at='2026-10-07'",
    'header date': "UPDATE supply_invoices SET created_at='2026-10-07'",
    quantity: 'UPDATE supply_invoice_items SET qty=3,total=300; UPDATE supply_invoices SET total=300',
    'deleted line': "UPDATE supply_invoice_items SET deleted_at='2026-10-07'",
  }
  db.exec(updates[field]); const before = queue()
  expect(() => finish('cancelled', a)).toThrow(); expect(queue()).toEqual(before); expect(stock()).toBe(0)
})
it.each(['cancelled', 'deleted'] as const)('does not reuse a %s invoice ID', kind => {
  const a = create(); finish(kind, a)
  expect(() => supply.createInvoice({ id: a.id, items: [{ product_id: product, qty: 8, purchase_price: 100 }] })).toThrow(/уже завершено/)
})
it.each(['cancelled', 'deleted'] as const)('rejects incomplete or inconsistent %s line data', kind => {
  const a = create()
  db.exec('UPDATE supply_invoice_items SET total=199')
  expect(() => finish(kind, supply.getInvoice(a.id))).toThrow()
  db.exec('DELETE FROM supply_invoice_items')
  expect(() => finish(kind, supply.getInvoice(a.id))).toThrow()
  expect(queue()).toHaveLength(1)
})
it.each(['cancelled', 'deleted'] as const)('rolls back %s when queue write fails', kind => {
  const a = create(), invoice = kind === 'cancelled' ? supply.postInvoice(a.id) : a
  const before = queue(), beforeStock = stock()
  db.exec("CREATE TRIGGER test_terminal_queue BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice." + kind + "' BEGIN SELECT RAISE(ABORT,'queue failed'); END")
  expect(() => finish(kind, invoice)).toThrow('queue failed')
  expect(queue()).toEqual(before); expect(stock()).toBe(beforeStock)
  expect(supply.getInvoice(a.id).status).toBe(invoice.status)
  expect(db.prepare('SELECT * FROM app_meta WHERE key=?').get(receiptKey(a.id))).toBeUndefined()
})
it.each(['cancelled', 'deleted'] as const)('rolls back %s when durable receipt write fails, then finishes exactly once', kind => {
  const a = create(), invoice = kind === 'cancelled' ? supply.postInvoice(a.id) : a, before = queue(), beforeStock = stock()
  db.exec("CREATE TRIGGER test_terminal_receipt BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'supply-terminal:%' BEGIN SELECT RAISE(ABORT,'receipt failed'); END")
  expect(() => finish(kind, invoice)).toThrow('receipt failed')
  expect(queue()).toEqual(before); expect(stock()).toBe(beforeStock); expect(supply.getInvoice(a.id).status).toBe(invoice.status)
  db.exec('DROP TRIGGER test_terminal_receipt'); finish(kind, invoice); finish(kind, invoice)
  expect(queue()).toHaveLength(before.length + 1); expect(stock()).toBe(0)
})
it('refuses a resurrected deleted document rather than deleting new data under an old retry', () => {
  const a = create(); finish('deleted', a)
  db.prepare("INSERT INTO supply_invoices(id,tenant_id,status,total,created_at,updated_at) VALUES(?,?,'draft',999,?,?)").run(a.id, tenant, at, at)
  expect(() => finish('deleted', a)).toThrow(/Потрібна звірка/)
  expect((db.prepare('SELECT total FROM supply_invoices').get() as any).total).toBe(999)
})
