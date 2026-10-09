// Isolated synthetic data in the compiled Electron runtime. Never opens the shop DB.
const { mkdtempSync, rmSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { LocalDatabase } = require('../dist/db/localDatabase')
const { LocalSupplyRepository } = require('../dist/repositories/supplyRepository')
const { DEFAULT_TENANT_ID: tenant } = require('../dist/db/localTypes')
const root = mkdtempSync(path.join(tmpdir(), 'forsage-payment-write-smoke-'))
let db, supply, checks = 0
const equal = (a, b) => { assert.deepEqual(a, b); checks++ }
const rejects = action => { assert.throws(action); checks++ }
const snapshot = () => JSON.stringify(['supply_invoices', 'supply_invoice_items', 'supplier_payments', 'cash_operations', 'products', 'shifts', 'sync_outbox', 'app_meta']
  .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()))
const freshInvoice = () => supply.createInvoice({items: [{product_id: 'p', qty: 2, purchase_price: 100}]})
const freshPayment = () => ({payment_id: randomUUID(), amount: 75, payment_method: 'cash', fund_source: 'cashbox', shift_id: 'shift', user_id: 'owner', note: 'Fixture payment'})
try {
  db = new LocalDatabase(root); supply = new LocalSupplyRepository(db)
  const at = '2026-10-08T06:00:00.000Z'
  db.prepare('INSERT INTO products(id,tenant_id,sku,name,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p',tenant,'TEST','Fixture',at,at)
  db.prepare('INSERT INTO shifts(id,tenant_id,cashier_id,opening_cash,opened_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('shift',tenant,'owner',100000,at,at,at)
  let last
  for (const table of ['supplier_payments', 'cash_operations', 'supply_invoices', 'sync_outbox']) {
    const invoice = freshInvoice(), payment = freshPayment()
    db.exec('CREATE TRIGGER skip_payment BEFORE ' + (table === 'supply_invoices' ? 'UPDATE' : 'INSERT') + ' ON ' + table + ' BEGIN SELECT RAISE(IGNORE); END')
    const before = snapshot()
    rejects(() => supply.payInvoice(invoice.id, payment)); equal(snapshot(), before)
    db.exec('DROP TRIGGER skip_payment')
    const stock = JSON.stringify(db.prepare('SELECT * FROM products').all())
    equal(supply.payInvoice(invoice.id, payment).paid_amount, 75)
    equal(JSON.stringify(db.prepare('SELECT * FROM products').all()), stock)
    const after = snapshot(); supply.payInvoice(invoice.id, payment); equal(snapshot(), after)
    last = {invoice, payment}
  }
  for (const trigger of [
    "AFTER INSERT ON supplier_payments BEGIN UPDATE supplier_payments SET note='Wrong' WHERE id=NEW.id; END",
    "AFTER INSERT ON cash_operations BEGIN UPDATE cash_operations SET amount=amount+1 WHERE id=NEW.id; END",
    "AFTER UPDATE OF paid_amount ON supply_invoices BEGIN UPDATE supply_invoices SET notes='Wrong' WHERE id=NEW.id; END",
    "AFTER UPDATE OF paid_amount ON supply_invoices BEGIN UPDATE supply_invoice_items SET qty=1,purchase_price=200 WHERE invoice_id=NEW.id; END",
    "AFTER INSERT ON sync_outbox BEGIN UPDATE sync_outbox SET payload_json='{}' WHERE operation_id=NEW.operation_id; END",
    "AFTER INSERT ON sync_outbox BEGIN UPDATE cash_operations SET amount=amount+1; END",
  ]) {
    const invoice = freshInvoice(), payment = freshPayment()
    db.exec('CREATE TRIGGER alter_payment ' + trigger)
    const before = snapshot()
    rejects(() => supply.payInvoice(invoice.id, payment)); equal(snapshot(), before)
    db.exec('DROP TRIGGER alter_payment')
  }
  for (const table of ['supplier_payments', 'cash_operations']) {
    db.exec('CREATE TRIGGER alter_initial AFTER INSERT ON sync_outbox BEGIN UPDATE ' + table + ' SET amount=amount+1; END')
    const before = snapshot()
    rejects(() => supply.createInvoice({paid_amount: 75, payment_method: 'cash', fund_source: 'cashbox', shift_id: 'shift', user_id: 'owner', items: [{product_id: 'p', qty: 2, purchase_price: 100}]}))
    equal(snapshot(), before)
    db.exec('DROP TRIGGER alter_initial')
  }
  for (const source of ['owner_funds', 'bank_account', 'business_card']) {
    const invoice = freshInvoice(), payment = {...freshPayment(), fund_source: source, payment_method: source === 'owner_funds' ? 'cash' : 'card', shift_id: null}
    const cash = JSON.stringify(db.prepare('SELECT * FROM cash_operations').all())
    supply.payInvoice(invoice.id, payment)
    equal(JSON.stringify(db.prepare('SELECT * FROM cash_operations').all()), cash)
    const after = snapshot(); supply.payInvoice(invoice.id, payment); equal(snapshot(), after)
  }
  db.prepare('UPDATE shifts SET closed_at=?').run(at)
  db.exec('DELETE FROM sync_outbox')
  db.close(); db = new LocalDatabase(root); supply = new LocalSupplyRepository(db)
  const before = snapshot(); supply.payInvoice(last.invoice.id, last.payment); equal(snapshot(), before)
  db.exec('DELETE FROM cash_operations')
  const damaged = snapshot(); rejects(() => supply.payInvoice(last.invoice.id, last.payment)); equal(snapshot(), damaged)
  console.log(JSON.stringify({ok: true, checks, packagedExe: false, shopDatabaseOpened: false, networkRequests: false, printerJobs: false}))
} finally {
  db?.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-payment-write-smoke-')) rmSync(root, {recursive: true, force: true})
}
