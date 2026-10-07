import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { attachBalanceSnapshots } from '../src/repositories/balanceSnapshot'
let root: string, db: LocalDatabase, supply: LocalSupplyRepository
const actor = randomUUID(), product = randomUUID(), supplier = randomUUID(), other = randomUUID()
const at = '2026-10-05T10:00:00.000Z'
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-invoice-copy-')); db = new LocalDatabase(root); supply = new LocalSupplyRepository(db)
  db.prepare('INSERT INTO products(id,tenant_id,sku,name,purchase_price,created_at,updated_at) VALUES(?,?,?,?,999,?,?)')
    .run(product, tenant, 'TEST-COPY', 'Тест', at, at)
  db.prepare('INSERT INTO suppliers(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(supplier, tenant, 'Тест', at, at)
})
afterEach(() => {
  db.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-invoice-copy-')) rmSync(root, { recursive: true, force: true })
})
function create(paid = 100) {
  return supply.createInvoice({ supplier_id: supplier, user_id: actor, invoice_number: 'TEST', paid_amount: paid,
    payment_method: paid ? 'cash' : null, fund_source: 'owner_funds', items: [{ product_id: product, qty: 2, purchase_price: 100 }] })
}
function queued(id: string): any {
  const row = db.prepare("SELECT * FROM sync_outbox WHERE aggregate_id=? AND operation_type='supplier_invoice.created'").get(id) as any
  return { ...row, payload: JSON.parse(row.payload_json) }
}
it('captures the original payer, exact total and line dates in the saved queue', () => {
  const invoice = create(), op = queued(invoice.id)
  expect(op.payload).toMatchObject({ user_id: actor, total: 200, created_at: invoice.created_at, paid_amount: 100 })
  expect(op.payload.items[0]).toMatchObject({ id: invoice.items[0].id, qty: 2, purchase_price: 100, total: 200, created_at: invoice.items[0].created_at })
  expect((db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(product) as any).qty_on_hand).toBe(0)
})
it('sends unpaid creation without inventing a payer or payment', () => {
  const invoice = create(0), op = queued(invoice.id)
  expect(op.payload).toMatchObject({ paid_amount: 0, payment_id: null, payment_method: null, total: 200 })
})
it('recovers only omitted legacy payer from the exact payment after restart, read-only', () => {
  const invoice = create(), op = queued(invoice.id); delete op.payload.user_id
  const before = db.prepare('SELECT payload_json FROM sync_outbox WHERE operation_id=?').get(op.operation_id)
  db.close(); db = new LocalDatabase(root)
  db.exec('PRAGMA query_only=ON')
  const copy = attachBalanceSnapshots(db, [op])[0]
  expect(copy.payload.user_id).toBe(actor)
  expect(op.payload.user_id).toBeUndefined()
  expect(db.prepare('SELECT payload_json FROM sync_outbox WHERE operation_id=?').get(op.operation_id)).toEqual(before)
  expect((db.prepare('SELECT created_by FROM supplier_payments').get() as any).created_by).toBe(actor)
})
it.each(['amount', 'invoice', 'supplier', 'method', 'source', 'shift', 'note', 'date', 'tenant', 'deleted', 'missing'])
  ('does not recover payer from mismatched %s', kind => {
    const invoice = create(), op = queued(invoice.id); delete op.payload.user_id
    const statements: Record<string, [string, unknown[]]> = {
      amount: ['UPDATE supplier_payments SET amount=99', []],
      invoice: ['UPDATE supplier_payments SET invoice_id=?', [kind === 'invoice' ? create(0).id : other]],
      supplier: ['UPDATE supplier_payments SET supplier_id=NULL', []],
      method: ["UPDATE supplier_payments SET payment_method='transfer'", []],
      source: ["UPDATE supplier_payments SET fund_source='bank_account'", []],
      shift: ['UPDATE supplier_payments SET shift_id=?', [other]],
      note: ["UPDATE supplier_payments SET note='інша'", []],
      date: ['UPDATE supplier_payments SET created_at=?', [at]],
      tenant: ['UPDATE supplier_payments SET tenant_id=?', [other]],
      deleted: ['UPDATE supplier_payments SET deleted_at=?', [at]],
      missing: ['DELETE FROM supplier_payments', []],
    }
    const [sql, args] = statements[kind]
    if (kind === 'shift') op.payload.shift_id = other
    else db.prepare(sql).run(...args as any[])
    expect(attachBalanceSnapshots(db, [op])[0].payload.user_id).toBeUndefined()
  })
it.each([null, other])('does not overwrite an explicit queued payer %s', value => {
  const invoice = create(), op = queued(invoice.id); op.payload.user_id = value
  expect(attachBalanceSnapshots(db, [op])[0].payload.user_id).toBe(value)
})
it('keeps the original creation after invoice edits rather than copying today\'s document over it', () => {
  const invoice = create(), op = queued(invoice.id)
  delete op.payload.user_id
  supply.updateInvoice(invoice.id, { items: [{ product_id: product, qty: 5, purchase_price: 150 }] })
  const copy = attachBalanceSnapshots(db, [op])[0]
  expect(copy.payload.items).toEqual(op.payload.items)
  expect(copy.payload.total).toBe(200)
  expect(copy.payload.user_id).toBe(actor)
  expect(supply.getInvoice(invoice.id).total).toBe(750)
})
it('keeps explicit unknown payer unknown rather than attributing it to the current session', () => {
  const invoice = create(), op = queued(invoice.id)
  delete op.payload.user_id
  db.exec('UPDATE supplier_payments SET created_by=NULL')
  expect(attachBalanceSnapshots(db, [op])[0].payload.user_id).toBeNull()
})
it('refuses cross-document payload identity during legacy enrichment', () => {
  const invoice = create(), op = queued(invoice.id); delete op.payload.user_id; op.payload.id = other
  expect(attachBalanceSnapshots(db, [op])[0].payload.user_id).toBeUndefined()
})

function additionalPayment() {
  const invoice = create(0)
  const input = { payment_id: randomUUID(), user_id: actor, amount: 75, payment_method: 'cash' as const,
    fund_source: 'owner_funds' as const, note: 'Доплата' }
  supply.payInvoice(invoice.id, input)
  return { invoice, input, op: allQueued(invoice.id).find(op => op.operation_type === 'supplier_invoice.payment_added') }
}
it('captures original supplier, payer and date for each additional payment', () => {
  const { invoice, input, op } = additionalPayment()
  expect(op.payload).toMatchObject({ id: invoice.id, payment_id: input.payment_id, supplier_id: supplier,
    user_id: actor, amount: 75, created_at: op.created_at, note: 'Доплата' })
  expect((db.prepare('SELECT qty_on_hand FROM products').get() as any).qty_on_hand).toBe(0)
})
it('recovers omitted old payment fields after restart without queue writes', () => {
  const { invoice, op } = additionalPayment(), before = allQueued(invoice.id)
  delete op.payload.supplier_id; delete op.payload.created_at; delete op.payload.user_id
  db.close(); db = new LocalDatabase(root); db.exec('PRAGMA query_only=ON')
  expect(attachBalanceSnapshots(db, [op])[0].payload).toMatchObject({ supplier_id: supplier, created_at: op.created_at, user_id: actor })
  expect(op.payload.supplier_id).toBeUndefined()
  expect(allQueued(invoice.id)).toEqual(before)
})
it.each(['amount', 'method', 'source', 'shift', 'note', 'date', 'actor', 'supplier', 'invoice', 'tenant', 'deleted', 'missing'])
  ('does not enrich a payment with mismatched %s', kind => {
    const { op } = additionalPayment()
    delete op.payload.supplier_id
    if (kind === 'amount') op.payload.amount++
    if (kind === 'method') op.payload.payment_method = 'transfer'
    if (kind === 'source') op.payload.fund_source = 'bank_account'
    if (kind === 'shift') op.payload.shift_id = other
    if (kind === 'note') op.payload.note = 'Інша'
    if (kind === 'date') op.payload.created_at = at
    if (kind === 'actor') op.payload.user_id = other
    if (kind === 'supplier') { op.payload.supplier_id = null; delete op.payload.created_at; delete op.payload.user_id }
    if (kind === 'invoice') op.payload.id = other
    if (kind === 'tenant') op.tenant_id = other
    if (kind === 'deleted') db.prepare('UPDATE supplier_payments SET deleted_at=?').run(at)
    if (kind === 'missing') db.exec('DELETE FROM supplier_payments')
    const enriched = attachBalanceSnapshots(db, [op])[0].payload
    if (kind === 'supplier') { expect(enriched.user_id).toBeUndefined(); expect(enriched.supplier_id).toBeNull() }
    else expect(enriched.supplier_id).toBeUndefined()
  })
it.each([null, other])('does not replace explicit payment payer %s with the current cashier', user => {
  const { op } = additionalPayment(); op.payload.user_id = user; delete op.payload.supplier_id
  const enriched = attachBalanceSnapshots(db, [op])[0].payload
  expect(enriched.user_id).toBe(user); expect(enriched.supplier_id).toBeUndefined()
})
it.each(['actor', 'note'])('rejects a local payment retry with a different %s', kind => {
  const { invoice, input } = additionalPayment(), before = allQueued(invoice.id)
  const changed = { ...input, ...(kind === 'actor' ? { user_id: other } : { note: 'Інша' }) }
  expect(() => supply.payInvoice(invoice.id, changed)).toThrow('Ідентифікатор оплати')
  expect(allQueued(invoice.id)).toEqual(before)
  expect(supply.getInvoice(invoice.id).paid_amount).toBe(75)
})
it('keeps exact local retry idempotent after restart and later changes', () => {
  const { invoice, input } = additionalPayment()
  supply.updateInvoice(invoice.id, { notes: 'Змінено після оплати' })
  db.close(); db = new LocalDatabase(root); supply = new LocalSupplyRepository(db)
  const before = allQueued(invoice.id)
  expect(supply.payInvoice(invoice.id, input).paid_amount).toBe(75)
  expect(allQueued(invoice.id)).toEqual(before)
  expect((db.prepare('SELECT count(*) n FROM supplier_payments').get() as any).n).toBe(1)
})
it('rolls back payment, invoice and queue together when payment enqueue fails', () => {
  const invoice = create(0), before = allQueued(invoice.id)
  db.exec("CREATE TRIGGER test_reject_supplier_pay BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice.payment_added' BEGIN SELECT RAISE(ABORT,'queue unavailable'); END")
  expect(() => supply.payInvoice(invoice.id, { amount: 75, payment_method: 'cash', fund_source: 'owner_funds', user_id: actor })).toThrow('queue unavailable')
  expect(supply.getInvoice(invoice.id).paid_amount).toBe(0)
  expect((db.prepare('SELECT count(*) n FROM supplier_payments').get() as any).n).toBe(0)
  expect(allQueued(invoice.id)).toEqual(before)
})
it.each(['card', 'transfer'] as const)('refuses %s from cashbox before local money is recorded', method => {
  const invoice = create(0), shiftId = openPaymentShift()
  expect(() => supply.payInvoice(invoice.id, { amount: 75, payment_method: method, fund_source: 'cashbox',
    shift_id: shiftId, user_id: actor })).toThrow('лише готівкою')
  expect(supply.getInvoice(invoice.id).paid_amount).toBe(0)
  expect((db.prepare('SELECT count(*) n FROM supplier_payments').get() as any).n).toBe(0)
  expect((db.prepare('SELECT count(*) n FROM cash_operations').get() as any).n).toBe(0)
})
function openPaymentShift(opening = 100) {
  const id = randomUUID()
  db.prepare("INSERT INTO shifts(id,tenant_id,cashier_id,status,opening_cash,opened_at,created_at,updated_at) VALUES(?,?,?,'open',?,?,?,?)")
    .run(id, tenant, actor, opening, at, at, at)
  return id
}
it.each(['closed', 'insufficient'])('still refuses an actual new local payment from a %s cash shift', kind => {
  const invoice = create(0), shiftId = openPaymentShift(kind === 'insufficient' ? 50 : 100)
  if (kind === 'closed') db.prepare("UPDATE shifts SET status='closed' WHERE id=?").run(shiftId)
  expect(() => supply.payInvoice(invoice.id, { amount: 75, payment_method: 'cash', fund_source: 'cashbox',
    shift_id: shiftId, user_id: actor })).toThrow()
  expect(supply.getInvoice(invoice.id).paid_amount).toBe(0)
  expect((db.prepare('SELECT count(*) n FROM cash_operations').get() as any).n).toBe(0)
})
it('rolls back a cash withdrawal if payment cannot be queued, then retries just once', () => {
  const invoice = create(0), shiftId = openPaymentShift()
  const input = { payment_id: randomUUID(), amount: 75, payment_method: 'cash' as const, fund_source: 'cashbox' as const,
    shift_id: shiftId, user_id: actor }
  db.exec("CREATE TRIGGER test_reject_supplier_pay BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice.payment_added' BEGIN SELECT RAISE(ABORT,'queue unavailable'); END")
  expect(() => supply.payInvoice(invoice.id, input)).toThrow('queue unavailable')
  expect((db.prepare('SELECT count(*) n FROM cash_operations').get() as any).n).toBe(0)
  expect(supply.getInvoice(invoice.id).paid_amount).toBe(0)
  db.exec('DROP TRIGGER test_reject_supplier_pay')
  supply.payInvoice(invoice.id, input)
  db.prepare("UPDATE shifts SET status='closed' WHERE id=?").run(shiftId)
  supply.payInvoice(invoice.id, input)
  expect((db.prepare('SELECT count(*) n FROM cash_operations').get() as any).n).toBe(1)
  expect(supply.getInvoice(invoice.id).paid_amount).toBe(75)
})

function allQueued(id: string): any[] {
  return (db.prepare('SELECT * FROM sync_outbox WHERE aggregate_id=? ORDER BY sequence').all(id) as any[])
    .map(row => ({ ...row, payload: JSON.parse(row.payload_json) }))
}
it('captures complete before/after contents for quantity corrections and posting', () => {
  const a = create(0)
  const b = supply.updateInvoice(a.id, { items: [{ product_id: product, qty: 98, purchase_price: 100 }], notes: '98 шт' })
  const c = supply.postInvoice(a.id, { user_id: actor })
  const [creation, update, posting] = allQueued(a.id)
  expect(creation.payload.items[0].qty).toBe(2)
  expect(update.payload.previous_invoice.items[0].qty).toBe(2)
  expect(update.payload.previous_invoice.items[0].id).toBe(a.items[0].id)
  expect(update.payload.previous_invoice.created_at).toBe(a.created_at)
  expect(update.payload.items[0]).toMatchObject({ id: b.items[0].id, qty: 98, total: 9800, created_at: b.items[0].created_at })
  expect(update.payload.created_at).toBe(update.created_at)
  expect(posting.payload.invoice_snapshot.items).toEqual(update.payload.items)
  expect(posting.payload.invoice_snapshot).toMatchObject({ total: 9800, notes: '98 шт', created_at: a.created_at })
  expect(posting.payload).toMatchObject({ created_at: c.posted_at, user_id: actor })
  expect((db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(product) as any).qty_on_hand).toBe(98)
})
it('preserves exact line identity/date for a header-only edit', () => {
  const a = create(0); supply.updateInvoice(a.id, { notes: 'Тільки примітка' })
  const [creation, update] = allQueued(a.id)
  expect(update.payload.items).toEqual(creation.payload.items)
  expect(update.payload.previous_invoice.items).toEqual(creation.payload.items)
})
it('keeps the entire queued lifecycle immutable across restart and send-time snapshots', () => {
  const a = create(0)
  supply.updateInvoice(a.id, { items: [{ product_id: product, qty: 98, purchase_price: 100 }] })
  supply.postInvoice(a.id, { user_id: actor })
  const before = allQueued(a.id)
  db.close(); db = new LocalDatabase(root); db.exec('PRAGMA query_only=ON')
  const outgoing = attachBalanceSnapshots(db, before)
  for (let index = 0; index < before.length; index++) {
    const { local_balance_snapshot: _balance, ...payload } = outgoing[index].payload
    expect(payload).toEqual(before[index].payload)
  }
  expect(allQueued(a.id)).toEqual(before)
})
it('rolls back local document and queue if the correction cannot be queued', () => {
  const a = create(0), before = allQueued(a.id)
  db.exec("CREATE TRIGGER test_reject_invoice_update BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice.updated' BEGIN SELECT RAISE(ABORT,'queue unavailable'); END")
  expect(() => supply.updateInvoice(a.id, { items: [{ product_id: product, qty: 98, purchase_price: 100 }] })).toThrow('queue unavailable')
  expect(supply.getInvoice(a.id).items[0].qty).toBe(2)
  expect(allQueued(a.id)).toEqual(before)
})
it('rolls back local stock, posting and queue when posting cannot be queued', () => {
  const a = create(0), before = allQueued(a.id)
  db.exec("CREATE TRIGGER test_reject_invoice_post BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice.posted' BEGIN SELECT RAISE(ABORT,'queue unavailable'); END")
  expect(() => supply.postInvoice(a.id, { user_id: actor })).toThrow('queue unavailable')
  expect(supply.getInvoice(a.id).status).toBe('draft')
  expect((db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(product) as any).qty_on_hand).toBe(0)
  expect(allQueued(a.id)).toEqual(before)
})
