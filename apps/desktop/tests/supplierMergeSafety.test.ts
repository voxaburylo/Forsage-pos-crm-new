import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { supplierMergeReceiptKey } from '../src/repositories/supplierMergeSafety'

let root: string, db: LocalDatabase, supply: LocalSupplyRepository, target: string, source: string
const at = '2026-10-06T09:00:00Z'
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-supplier-merge-'))
  db = new LocalDatabase(root); supply = new LocalSupplyRepository(db)
  target = supply.saveSupplier({ name: 'Основний' }).id
  source = supply.saveSupplier({ name: 'Дублікат' }).id
  db.prepare('INSERT INTO products(id,tenant_id,sku,name,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run('p', tenant, 'TEST', 'Тест', at, at)
})
afterEach(() => {
  db.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-supplier-merge-')) rmSync(root, { recursive: true, force: true })
})
const snap = () => Object.fromEntries(['suppliers','supply_invoices','supply_invoice_items','supplier_payments','products','cash_operations','sync_outbox','app_meta']
  .map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
const merge = () => supply.mergeSuppliers(target, source)

it.each(['supply_invoices','supplier_payments','cash_operations','suppliers','sync_outbox','app_meta','empty suppliers','empty sync_outbox','empty app_meta'])('rolls back silently skipped merge writes: %s', kind => {
  const table = kind.replace('empty ', '')
  if (!kind.startsWith('empty ')) {
    db.prepare('INSERT INTO shifts(id,tenant_id,cashier_id,opening_cash,opened_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('shift',tenant,'owner',1000,at,at,at)
    const a = supply.createInvoice({supplier_id:source,paid_amount:25,payment_method:'cash',fund_source:'cashbox',shift_id:'shift',user_id:'owner',items:[{product_id:'p',qty:2,purchase_price:100}]})
    supply.postInvoice(a.id)
    supply.payInvoice(a.id,{amount:50,payment_method:'cash',fund_source:'cashbox',shift_id:'shift',user_id:'owner'})
    invoice()
  }
  const insert = table === 'sync_outbox' || table === 'app_meta'
  const when = table === 'sync_outbox' ? " WHEN NEW.operation_type='supplier.merged'" : table === 'app_meta' ? " WHEN NEW.key LIKE 'supplier-merge:%'" : ''
  db.exec('CREATE TRIGGER skip_merge BEFORE ' + (insert ? 'INSERT' : 'UPDATE') + ' ON ' + table + when + ' BEGIN SELECT RAISE(IGNORE); END')
  const before = snap()
  expect(merge).toThrow()
  expect(snap()).toEqual(before)
  db.exec('DROP TRIGGER skip_merge')
  merge()
  const after = snap(); merge(); expect(snap()).toEqual(after)
  expect(db.prepare("SELECT * FROM sync_outbox WHERE operation_type='supplier.merged'").all()).toHaveLength(1)
})
const invoice = (supplier_id = source) => supply.createInvoice({ supplier_id, items: [{ product_id: 'p', qty: 2, purchase_price: 100 }] })

it.each(['supply_invoices','supplier_payments'])('rolls back a partially skipped transfer in %s', table => {
  const a=invoice(),b=invoice()
  for (const i of [a,b]) supply.payInvoice(i.id,{amount:25,payment_method:'cash',fund_source:'owner_funds'})
  const id=(db.prepare('SELECT id FROM '+table+' WHERE supplier_id=? ORDER BY id LIMIT 1').get(source) as any).id
  db.exec("CREATE TRIGGER skip_one BEFORE UPDATE ON "+table+" WHEN OLD.id='"+id+"' BEGIN SELECT RAISE(IGNORE); END")
  const before=snap();expect(merge).toThrow();expect(snap()).toEqual(before)
  db.exec('DROP TRIGGER skip_one');merge()
})

it.each(['supply_invoices','supplier_payments','cash_operations','suppliers','target','sync_outbox','app_meta','late cash'])('checks actual merge contents after %s write', kind => {
  db.prepare('INSERT INTO shifts(id,tenant_id,cashier_id,opening_cash,opened_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('shift',tenant,'owner',1000,at,at,at)
  const a=supply.createInvoice({supplier_id:source,paid_amount:25,payment_method:'cash',fund_source:'cashbox',shift_id:'shift',user_id:'owner',items:[{product_id:'p',qty:2,purchase_price:100}]})
  let trigger: string
  if(kind==='late cash') trigger="AFTER INSERT ON app_meta WHEN NEW.key LIKE 'supplier-merge:%' BEGIN UPDATE cash_operations SET amount=amount+1 WHERE supplier_id='"+target+"'; END"
  else if(kind==='target') trigger="AFTER UPDATE ON suppliers WHEN NEW.id='"+source+"' BEGIN UPDATE suppliers SET name='Changed' WHERE id='"+target+"'; END"
  else if(kind==='sync_outbox') trigger="AFTER INSERT ON sync_outbox WHEN NEW.operation_type='supplier.merged' BEGIN UPDATE sync_outbox SET payload_json='{}' WHERE operation_id=NEW.operation_id; END"
  else if(kind==='app_meta') trigger="AFTER INSERT ON app_meta WHEN NEW.key LIKE 'supplier-merge:%' BEGIN DELETE FROM app_meta WHERE key=NEW.key; END"
  else {
    const field=kind==='suppliers'?'name':kind==='supply_invoices'?'notes':'amount'
    const value=field==='amount'?'NEW.amount+1':"'Changed'"
    trigger="AFTER UPDATE ON "+kind+" BEGIN UPDATE "+kind+" SET "+field+"="+value+" WHERE id=NEW.id; END"
  }
  db.exec('CREATE TRIGGER alter_merge '+trigger)
  const before=snap();expect(merge).toThrow();expect(snap()).toEqual(before)
  db.exec('DROP TRIGGER alter_merge');merge();expect(supply.getInvoice(a.id).supplier_id).toBe(target)
})

it('rejects coherent line changes during a supplier transfer', () => {
  invoice()
  db.exec('CREATE TRIGGER alter_lines AFTER UPDATE OF supplier_id ON supply_invoices BEGIN UPDATE supply_invoice_items SET qty=1,purchase_price=200 WHERE invoice_id=NEW.id; END')
  const before=snap();expect(merge).toThrow();expect(snap()).toEqual(before)
  db.exec('DROP TRIGGER alter_lines');merge()
})

it('merges an empty duplicate once, survives restart and queue cleanup without changing the primary', () => {
  const before = supply.getSupplier(target), result = merge()
  expect(result).toEqual(before)
  expect(db.prepare('SELECT is_active FROM suppliers WHERE id=?').get(source)).toEqual({ is_active: 0 })
  expect(() => supply.getSupplier(source)).toThrow()
  db.exec('DELETE FROM sync_outbox'); db.close(); db = new LocalDatabase(root); supply = new LocalSupplyRepository(db)
  const after = snap(); expect(merge()).toEqual(result); expect(snap()).toEqual(after)
})
it('does not invalidate the primary supplier invoice history', () => {
  const a = invoice(target); supply.cancelInvoice(a.id)
  const before = supply.getInvoice(a.id)
  merge()
  expect(supply.getInvoice(a.id)).toEqual(before)
  expect(supply.cancelInvoice(a.id, tenant, a.edit_revision).status).toBe('cancelled')
})
it('moves already deleted history without restoring invoices, lines or rewriting old deletion requests', () => {
  const a=invoice();supply.deleteInvoice(a.id,tenant,a.edit_revision)
  const key='supply-terminal:'+tenant+':'+a.id
  const original=JSON.parse((db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(key) as any).value_json)
  const events=db.prepare('SELECT * FROM sync_outbox WHERE aggregate_id=? ORDER BY sequence').all(a.id),stock=db.prepare('SELECT * FROM products').all()
  merge()
  const saved=JSON.parse((db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(key) as any).value_json)
  expect(saved).toEqual({...original,current_supplier_id:target})
  const event=db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type='supplier.merged'").get() as any
  expect(JSON.parse(event.payload_json).invoices[0]).toMatchObject({id:a.id,status:'deleted',deleted_at:original.payload.created_at,paid_amount:0,payments:[],snapshot:{supplier_id:source,total:200}})
  expect(db.prepare('SELECT * FROM sync_outbox WHERE aggregate_id=? ORDER BY sequence').all(a.id)).toEqual(events)
  const third=supply.saveSupplier({name:'Третій'}).id;supply.mergeSuppliers(third,target)
  db.exec('DELETE FROM sync_outbox');db.close();db=new LocalDatabase(root);supply=new LocalSupplyRepository(db)
  const before=snap();merge();supply.mergeSuppliers(third,target);supply.deleteInvoice(a.id,tenant,a.edit_revision);expect(snap()).toEqual(before)
  expect(db.prepare('SELECT * FROM supply_invoices').all()).toHaveLength(0)
  expect(db.prepare('SELECT * FROM supply_invoice_items').all()).toHaveLength(0)
  expect(db.prepare('SELECT * FROM products').all()).toEqual(stock)
})
it('includes a previously deleted draft with active, posted, paid and cancelled documents', () => {
  invoice();const posted=invoice();supply.postInvoice(posted.id)
  supply.payInvoice(posted.id,{amount:50,payment_method:'cash',fund_source:'owner_funds'})
  const cancelled=invoice();supply.cancelInvoice(cancelled.id)
  const deleted=invoice();supply.deleteInvoice(deleted.id)
  const debt=supply.getSupplierDebts().total_debt,stock=db.prepare('SELECT * FROM products').all()
  merge();expect(merge).not.toThrow()
  const event=db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type='supplier.merged'").get() as any
  expect(JSON.parse(event.payload_json).invoices).toHaveLength(4)
  expect(supply.getSupplierDebts().total_debt).toBe(debt);expect(db.prepare('SELECT * FROM products').all()).toEqual(stock)
})
it('accepts a draft merged, reassigned, deleted and merged again without recreating it', () => {
  const a=invoice();merge();const third=supply.saveSupplier({name:'Третій'}).id,fourth=supply.saveSupplier({name:'Четвертий'}).id
  supply.updateInvoice(a.id,{supplier_id:third});supply.deleteInvoice(a.id);supply.mergeSuppliers(fourth,third)
  const before=snap();merge();supply.mergeSuppliers(fourth,third);expect(snap()).toEqual(before)
})
it.each(['missing snapshot','bad sum','fractional money','duplicate line','bad date','posted history','wrong identity','forged supplier'])('blocks damaged deleted proof: %s', kind => {
  const a=invoice();supply.deleteInvoice(a.id);const key='supply-terminal:'+tenant+':'+a.id
  const receipt=JSON.parse((db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(key) as any).value_json)
  if(kind==='missing snapshot') delete receipt.payload.previous_invoice
  if(kind==='bad sum') receipt.payload.previous_invoice.total=1
  if(kind==='fractional money') receipt.payload.previous_invoice.items[0].purchase_price=0.5
  if(kind==='duplicate line') receipt.payload.previous_invoice.items.push({...receipt.payload.previous_invoice.items[0]})
  if(kind==='bad date') receipt.payload.created_at='invalid'
  if(kind==='posted history') receipt.payload.previous_status='posted'
  if(kind==='wrong identity') receipt.payload.id='wrong'
  if(kind==='forged supplier') receipt.current_supplier_id=target
  db.prepare('UPDATE app_meta SET value_json=? WHERE key=?').run(JSON.stringify(receipt),key)
  const before=snap();expect(merge).toThrow();expect(snap()).toEqual(before)
})
it.each(['supply_invoice_items','supplier_payments','supply_invoices','foreign receipt'])('blocks surviving or foreign deleted dependency %s', kind => {
  const a=invoice(),old=snap();supply.deleteInvoice(a.id)
  if(kind==='foreign receipt') db.prepare('UPDATE app_meta SET key=? WHERE key=?').run('supply-terminal:other:'+a.id,'supply-terminal:'+tenant+':'+a.id)
  else {
    const row=(old[kind] as any[])[0] ?? {id:'orphan',tenant_id:tenant,invoice_id:a.id,supplier_id:source,amount:1,payment_method:'cash',fund_source:'owner_funds',created_at:at,updated_at:at}
    db.exec('PRAGMA foreign_keys=OFF')
    const cols=Object.keys(row);db.prepare('INSERT INTO '+kind+'('+cols.join(',')+') VALUES('+cols.map(()=>'?').join(',')+')').run(...cols.map(k=>row[k]))
    db.exec('PRAGMA foreign_keys=ON')
  }
  const before=snap();expect(merge).toThrow();expect(snap()).toEqual(before)
})
it.each(['terminal update','merge receipt','outbox'])('rolls back all mixed history if %s fails', kind => {
  invoice();const a=invoice();supply.deleteInvoice(a.id)
  const sql=kind==='terminal update'?"BEFORE UPDATE ON app_meta WHEN NEW.key LIKE 'supply-terminal:%'":kind==='merge receipt'?"BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'supplier-merge:%'":"BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='supplier.merged'"
  db.exec("CREATE TRIGGER fail_deleted_merge "+sql+" BEGIN SELECT RAISE(ABORT,'test failure'); END")
  const before=snap();expect(merge).toThrow('test failure');expect(snap()).toEqual(before)
})
it.each(['changed snapshot','changed date','missing transfer proof','rolled back destination'])('rejects damaged deleted merge retry: %s', kind => {
  const a=invoice();supply.deleteInvoice(a.id);merge()
  const key='supply-terminal:'+tenant+':'+a.id,receipt=JSON.parse((db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(key) as any).value_json)
  if(kind==='changed snapshot') receipt.payload.previous_invoice.notes='changed'
  if(kind==='changed date') receipt.payload.created_at='2026-10-07T00:00:00.000Z'
  if(kind==='missing transfer proof') db.prepare('DELETE FROM app_meta WHERE key=?').run(supplierMergeReceiptKey(tenant,source))
  if(kind==='rolled back destination') receipt.current_supplier_id=source
  db.prepare('UPDATE app_meta SET value_json=? WHERE key=?').run(JSON.stringify(receipt),key)
  const before=snap();expect(merge).toThrow();expect(snap()).toEqual(before)
})
it.each(['draft','cancelled draft','cancelled posted'])('moves %s without stock, money or old event changes', kind => {
  const a = invoice()
  if (kind === 'cancelled posted') supply.postInvoice(a.id)
  const beforeCancel = supply.getInvoice(a.id)
  if (kind !== 'draft') supply.cancelInvoice(a.id,tenant,beforeCancel.edit_revision)
  const stock=db.prepare('SELECT * FROM products').all(), movements=db.prepare('SELECT * FROM inventory_movements').all()
  const original=db.prepare('SELECT * FROM sync_outbox WHERE aggregate_id=? ORDER BY sequence').all(a.id)
  merge()
  expect(supply.getInvoice(a.id)).toMatchObject({supplier_id:target,status:kind==='draft'?'draft':'cancelled',paid_amount:0})
  expect(db.prepare('SELECT * FROM products').all()).toEqual(stock)
  expect(db.prepare('SELECT * FROM inventory_movements').all()).toEqual(movements)
  expect(db.prepare('SELECT * FROM sync_outbox WHERE aggregate_id=? ORDER BY sequence').all(a.id)).toEqual(original)
  const third=supply.saveSupplier({name:'Третій'}).id
  supply.mergeSuppliers(third,target)
  db.exec('DELETE FROM sync_outbox'); db.close(); db=new LocalDatabase(root); supply=new LocalSupplyRepository(db)
  const before=snap(); merge(); supply.mergeSuppliers(third,target)
  if(kind!=='draft') supply.cancelInvoice(a.id,tenant,beforeCancel.edit_revision)
  expect(snap()).toEqual(before)
})
it.each([25,200])('moves a paid draft (%i), preserving initial payment retry', paid => {
  const a=supply.createInvoice({operation_id:'draft-create',supplier_id:source,paid_amount:paid,payment_method:'cash',
    fund_source:'owner_funds',user_id:'owner',items:[{product_id:'p',qty:2,purchase_price:100}]})
  const cash=db.prepare('SELECT * FROM cash_operations').all(),stock=db.prepare('SELECT * FROM products').all()
  merge(); expect(supply.getInvoice(a.id)).toMatchObject({status:'draft',supplier_id:target,paid_amount:paid})
  expect(db.prepare('SELECT * FROM products').all()).toEqual(stock)
  expect(db.prepare('SELECT * FROM cash_operations').all()).toEqual(cash)
  expect(merge).not.toThrow()
  const before=snap(); expect(()=>supply.updateInvoice(a.id,{supplier_id:null})).toThrow(/оплат/);expect(snap()).toEqual(before)
})
it.each(['post','cancel','delete','edit','reassign','clear supplier'])('supports %s after a draft merge, then repeats safely', action => {
  const a=invoice(); merge()
  if(action==='post') supply.postInvoice(a.id)
  if(action==='cancel') supply.cancelInvoice(a.id)
  if(action==='delete') supply.deleteInvoice(a.id)
  if(action==='edit') supply.updateInvoice(a.id,{items:[{product_id:'p',qty:3,purchase_price:100}]})
  if(action==='reassign') supply.updateInvoice(a.id,{supplier_id:supply.saveSupplier({name:'Новий'}).id})
  if(action==='clear supplier') supply.updateInvoice(a.id,{supplier_id:null})
  db.exec('DELETE FROM sync_outbox'); db.close(); db=new LocalDatabase(root); supply=new LocalSupplyRepository(db)
  const before=snap(); expect(merge).not.toThrow(); expect(snap()).toEqual(before)
  if(action==='delete') expect(()=>supply.getInvoice(a.id)).toThrow()
})
it('retains proof through explicit reassignment followed by another merge', () => {
  const a=invoice(); merge()
  const third=supply.saveSupplier({name:'Третій'}).id, fourth=supply.saveSupplier({name:'Четвертий'}).id
  supply.updateInvoice(a.id,{supplier_id:third}); supply.mergeSuppliers(fourth,third)
  const before=snap(); merge(); expect(snap()).toEqual(before)
})
it.each(['edit','post','pay','delete','cancel'])('rejects stale %s after transfer and preserves the draft', action => {
  const a=invoice(); merge(); const before=snap()
  const call=()=> {
    if(action==='edit') supply.updateInvoice(a.id,{expected_revision:a.edit_revision,supplier_id:source})
    if(action==='post') supply.postInvoice(a.id,{expected_revision:a.edit_revision})
    if(action==='pay') supply.payInvoice(a.id,{expected_revision:a.edit_revision,amount:1,payment_method:'cash',fund_source:'owner_funds'})
    if(action==='delete') supply.deleteInvoice(a.id,tenant,a.edit_revision)
    if(action==='cancel') supply.cancelInvoice(a.id,tenant,a.edit_revision)
  }
  expect(call).toThrow(); expect(snap()).toEqual(before)
})
it.each(['status','quantity','receipt','paid'])('refuses damaged cancelled history: %s', kind => {
  const a=invoice(); supply.cancelInvoice(a.id)
  if(kind==='status') db.exec("UPDATE supply_invoices SET status='draft'")
  if(kind==='quantity') db.exec('UPDATE supply_invoice_items SET qty=3,total=300; UPDATE supply_invoices SET total=300')
  if(kind==='receipt') db.prepare("UPDATE app_meta SET value_json='{}' WHERE key=?").run('supply-terminal:'+tenant+':'+a.id)
  if(kind==='paid') db.exec("UPDATE supply_invoices SET paid_amount=1,payment_method='cash'")
  const before=snap();expect(merge).toThrow();expect(snap()).toEqual(before)
})
it('rolls back supplier transfer if cancelled fingerprint cannot be advanced', () => {
  const a=invoice();supply.cancelInvoice(a.id)
  db.exec("CREATE TRIGGER fail_terminal BEFORE UPDATE ON app_meta WHEN NEW.key LIKE 'supply-terminal:%' BEGIN SELECT RAISE(ABORT,'terminal failed'); END")
  const before=snap();expect(merge).toThrow('terminal failed');expect(snap()).toEqual(before)
})
it.each(['missing','supplier','resurrected cancellation'])('rejects an unproven current draft/terminal change: %s', kind => {
  const a=invoice()
  if(kind==='resurrected cancellation') supply.cancelInvoice(a.id)
  merge()
  if(kind==='missing') db.exec('PRAGMA foreign_keys=OFF; DELETE FROM supply_invoice_items; DELETE FROM supply_invoices; PRAGMA foreign_keys=ON')
  if(kind==='supplier') db.prepare('UPDATE supply_invoices SET supplier_id=?').run(supply.saveSupplier({name:'Чужий'}).id)
  if(kind==='resurrected cancellation') db.exec("UPDATE supply_invoices SET status='draft'")
  const before=snap(); expect(merge).toThrow();expect(snap()).toEqual(before)
})
it('allows a consistent legacy cancelled invoice without inventing a terminal receipt', () => {
  const a=invoice();db.prepare("UPDATE supply_invoices SET status='cancelled' WHERE id=?").run(a.id)
  merge();expect(merge).not.toThrow()
  expect(db.prepare('SELECT 1 FROM app_meta WHERE key=?').get('supply-terminal:'+tenant+':'+a.id)).toBeUndefined()
})
it('rolls back an explicit supplier edit if durable provenance cannot be recorded', () => {
  const a=invoice();merge()
  db.exec("CREATE TRIGGER fail_change BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'invoice-supplier-changes:%' BEGIN SELECT RAISE(ABORT,'proof failed'); END")
  const before=snap();expect(()=>supply.updateInvoice(a.id,{supplier_id:null})).toThrow('proof failed');expect(snap()).toEqual(before)
})
it('blocks a missing reassignment proof even after queue cleanup', () => {
  const a=invoice();merge();supply.updateInvoice(a.id,{supplier_id:null})
  db.exec("DELETE FROM sync_outbox; DELETE FROM app_meta WHERE key LIKE 'invoice-supplier-changes:%'")
  const before=snap();expect(merge).toThrow();expect(snap()).toEqual(before)
})
it('moves mixed states without counting drafts and cancelled invoices as posted debt', () => {
  invoice();const b=invoice();supply.postInvoice(b.id);const c=invoice();supply.cancelInvoice(c.id)
  const before=supply.getSupplierDebts().total_debt;merge()
  expect(supply.getSupplierDebts().total_debt).toBe(before);expect(before).toBe(200)
})
it('does not accept supplier reassignment that happened before the merge as proof of a later change', () => {
  const a=invoice(target),third=supply.saveSupplier({name:'Третій'}).id
  supply.updateInvoice(a.id,{supplier_id:third});supply.updateInvoice(a.id,{supplier_id:source})
  merge();expect(merge).not.toThrow()
  db.prepare('UPDATE supply_invoices SET supplier_id=? WHERE id=?').run(third,a.id)
  const before=snap();expect(merge).toThrow();expect(snap()).toEqual(before)
})
it.each(['earlier edit','earlier merge'])('rejects rollback to an %s supplier even when historical proof exists', kind => {
  const a=invoice();merge();const third=supply.saveSupplier({name:'Третій'}).id,fourth=supply.saveSupplier({name:'Четвертий'}).id
  if(kind==='earlier edit') {
    supply.updateInvoice(a.id,{supplier_id:third});supply.updateInvoice(a.id,{supplier_id:fourth})
    db.prepare('UPDATE supply_invoices SET supplier_id=? WHERE id=?').run(third,a.id)
  } else {
    supply.mergeSuppliers(third,target)
    db.prepare('UPDATE supply_invoices SET supplier_id=? WHERE id=?').run(target,a.id)
  }
  const before=snap();expect(merge).toThrow();expect(snap()).toEqual(before)
})
it('keeps paid invoice, debt and cash movements intact', () => {
  const a = invoice(); supply.postInvoice(a.id)
  supply.payInvoice(a.id, { amount: 50, payment_method: 'cash', fund_source: 'owner_funds', user_id: 'owner' })
  const before = snap(), debts = supply.getSupplierDebts()
  merge()
  expect(supply.getInvoice(a.id).supplier_id).toBe(target)
  const after = snap()
  expect(after.products).toEqual(before.products)
  expect(after.cash_operations).toEqual(before.cash_operations)
  expect(supply.getSupplierDebts().total_debt).toBe(debts.total_debt)
  expect(supply.getSupplierDebts().suppliers[0].supplier_id).toBe(target)
})
it.each(['self','missing','foreign','inactive','deleted'])('rejects invalid pair: %s', kind => {
  if (kind === 'self') target = source
  if (kind === 'missing') source = 'missing'
  if (kind === 'foreign') db.prepare('UPDATE suppliers SET tenant_id=? WHERE id=?').run('other', source)
  if (kind === 'inactive') db.prepare('UPDATE suppliers SET is_active=0 WHERE id=?').run(target)
  if (kind === 'deleted') supply.deleteSupplier(source)
  const before = snap(); expect(merge).toThrow(); expect(snap()).toEqual(before)
})
it.each(['supplier_id','vendor_ref'])('blocks future references (%s), including foreign and deleted rows', column => {
  db.exec('CREATE TABLE future_refs(id TEXT,tenant_id TEXT,' + column + ' TEXT REFERENCES suppliers(id),deleted_at TEXT)')
  db.prepare('INSERT INTO future_refs VALUES(?,?,?,?)').run('ref', 'other', source, at)
  const before = snap(); expect(merge).toThrow(/історією/); expect(snap()).toEqual(before)
})
it('blocks supplier catalogue references', () => {
  db.prepare('INSERT INTO supplier_price_items(id,tenant_id,supplier_id,sku,name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('item', tenant, source, 'S', 'Price row', at, at)
  const before = snap(); expect(merge).toThrow(/прайси/); expect(snap()).toEqual(before)
})
it.each(['sync_outbox','app_meta'])('rolls back if %s write fails', table => {
  const condition = table === 'sync_outbox' ? "NEW.operation_type='supplier.merged'" : "NEW.key LIKE 'supplier-merge:%'"
  db.exec("CREATE TRIGGER fail_merge BEFORE INSERT ON " + table + " WHEN " + condition + " BEGIN SELECT RAISE(ABORT,'test failure'); END")
  const before = snap(); expect(merge).toThrow('test failure'); expect(snap()).toEqual(before)
  db.exec('DROP TRIGGER fail_merge'); merge(); expect(() => merge()).not.toThrow()
})
it.each(['corrupt','other target','resurrected'])('does not accept damaged replay: %s', kind => {
  merge()
  if (kind === 'corrupt') db.prepare("UPDATE app_meta SET value_json='{}' WHERE key=?").run(supplierMergeReceiptKey(tenant, source))
  if (kind === 'other target') target = supply.saveSupplier({ name: 'Інший' }).id
  if (kind === 'resurrected') db.prepare('UPDATE suppliers SET deleted_at=NULL,is_active=1 WHERE id=?').run(source)
  const before = snap(); expect(merge).toThrow(); expect(snap()).toEqual(before)
})
it('does not attach a new invoice or draft edit to a merged supplier from a stale form', () => {
  const a = invoice(target); merge(); const before = snap()
  expect(() => invoice()).toThrow()
  expect(() => supply.updateInvoice(a.id, { supplier_id: source })).toThrow()
  expect(snap()).toEqual(before)
})
it.each(['sync_outbox','app_meta','supplier_payments','supply_invoices'])('rolls back historical transfer if %s fails', table => {
  const a = invoice(); supply.postInvoice(a.id)
  supply.payInvoice(a.id, { amount: 50, payment_method: 'cash', fund_source: 'owner_funds', user_id: 'owner' })
  const insert = ['sync_outbox','app_meta'].includes(table)
  db.exec("CREATE TRIGGER fail_history BEFORE " + (insert ? 'INSERT' : 'UPDATE') + " ON " + table
    + (table === 'sync_outbox' ? " WHEN NEW.operation_type='supplier.merged'" : table === 'app_meta' ? " WHEN NEW.key LIKE 'supplier-merge:%'" : '')
    + " BEGIN SELECT RAISE(ABORT,'test failure'); END")
  const before = snap(); expect(merge).toThrow('test failure'); expect(snap()).toEqual(before)
})
it.each(['amount','line total','foreign line','foreign payment','orphan payment','deleted payment','cash orphan'])('refuses corrupted historical %s', kind => {
  const a = invoice(); supply.postInvoice(a.id)
  supply.payInvoice(a.id, { amount: 50, payment_method: 'cash', fund_source: 'owner_funds', user_id: 'owner' })
  if (kind === 'amount') db.exec('UPDATE supply_invoices SET paid_amount=0')
  if (kind === 'line total') db.exec('UPDATE supply_invoice_items SET total=1')
  if (kind === 'foreign line') db.exec("UPDATE supply_invoice_items SET tenant_id='other'")
  if (kind === 'foreign payment') db.exec("UPDATE supplier_payments SET tenant_id='other'")
  if (kind === 'orphan payment') db.exec("PRAGMA foreign_keys=OFF; UPDATE supplier_payments SET invoice_id='missing'; PRAGMA foreign_keys=ON")
  if (kind === 'deleted payment') db.prepare('UPDATE supplier_payments SET deleted_at=?').run(at)
  if (kind === 'cash orphan') db.prepare("INSERT INTO cash_operations(id,tenant_id,type,source,amount,supplier_id,created_at,updated_at) VALUES('cash',?,'supplier_payment','cashbox',50,?,?,?)").run(tenant,source,at,at)
  const before = snap(); expect(merge).toThrow(); expect(snap()).toEqual(before)
})
it('retains exact historical payload, payment IDs and debt through chained merges and restart', () => {
  const a = invoice(); supply.postInvoice(a.id)
  const payment = { payment_id: 'pay-id', amount: 50, payment_method: 'cash' as const, fund_source: 'owner_funds' as const, user_id: 'owner' }
  supply.payInvoice(a.id,payment)
  const originalEvents = db.prepare("SELECT * FROM sync_outbox WHERE aggregate_id=? ORDER BY sequence").all(a.id)
  const originalLines = db.prepare('SELECT * FROM supply_invoice_items').all()
  const beforeStock = db.prepare('SELECT * FROM products').all()
  merge()
  expect(db.prepare("SELECT * FROM sync_outbox WHERE aggregate_id=? ORDER BY sequence").all(a.id)).toEqual(originalEvents)
  const event = db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type='supplier.merged'").get() as any
  const payload = JSON.parse(event.payload_json)
  expect(payload.history_version).toBe(1); expect(payload.invoices[0].snapshot.supplier_id).toBe(source)
  expect(payload.invoices[0].payments[0]).toMatchObject({ id: 'pay-id', amount: 50, supplier_id: source })
  const third = supply.saveSupplier({name:'Третій'}).id
  supply.mergeSuppliers(third,target)
  supply.payInvoice(a.id,payment)
  db.exec('DELETE FROM sync_outbox'); db.close(); db=new LocalDatabase(root); supply=new LocalSupplyRepository(db)
  const before = snap(); merge(); expect(snap()).toEqual(before)
  expect(supply.getInvoice(a.id).supplier_id).toBe(third)
  expect(supply.getSupplierDebts().total_debt).toBe(150)
  expect(db.prepare('SELECT * FROM supply_invoice_items').all()).toEqual(originalLines)
  expect(db.prepare('SELECT * FROM products').all()).toEqual(beforeStock)
})
it('preserves cashbox movement and its identity when moving initial and later payments', () => {
  db.prepare("INSERT INTO shifts(id,tenant_id,cashier_id,opening_cash,opened_at,created_at,updated_at) VALUES('shift',?,'owner',1000,?,?,?)").run(tenant,at,at,at)
  const a = supply.createInvoice({supplier_id:source,paid_amount:25,payment_method:'cash',fund_source:'cashbox',shift_id:'shift',user_id:'owner',items:[{product_id:'p',qty:2,purchase_price:100}]})
  supply.postInvoice(a.id)
  const payment = {payment_id:'second-pay',amount:50,payment_method:'cash' as const,fund_source:'cashbox' as const,shift_id:'shift',user_id:'owner'}
  supply.payInvoice(a.id,payment)
  const beforeCash=db.prepare('SELECT * FROM cash_operations ORDER BY id').all() as any[]
  merge(); supply.payInvoice(a.id,payment)
  const afterCash=db.prepare('SELECT * FROM cash_operations ORDER BY id').all() as any[]
  expect(afterCash).toHaveLength(2)
  for(let n=0;n<beforeCash.length;n++) {
    const omit=(r:any)=>{const {supplier_id,dirty_at,updated_at,...stable}=r;return stable}
    expect(omit(afterCash[n])).toEqual(omit(beforeCash[n]))
    expect(afterCash[n].supplier_id).toBe(target)
  }
  expect(supply.getSupplierDebts().total_debt).toBe(125)
  expect(merge).not.toThrow()
})
it.each(['missing invoice','changed payment'])('refuses damaged historical merge acknowledgement: %s', kind => {
  const a=invoice(); supply.postInvoice(a.id)
  supply.payInvoice(a.id,{amount:50,payment_method:'cash',fund_source:'owner_funds',user_id:'owner'})
  merge()
  if(kind==='missing invoice') db.exec('PRAGMA foreign_keys=OFF; DELETE FROM supply_invoices; PRAGMA foreign_keys=ON')
  else db.exec('UPDATE supplier_payments SET amount=51')
  const before=snap(); expect(merge).toThrow(); expect(snap()).toEqual(before)
})
it('leaves an old incomplete payment queue untouched and waits for its copy', () => {
  const a=invoice(); supply.postInvoice(a.id)
  supply.payInvoice(a.id,{amount:50,payment_method:'cash',fund_source:'owner_funds',user_id:'owner'})
  const event=db.prepare("SELECT * FROM sync_outbox WHERE operation_type='supplier_invoice.payment_added'").get() as any
  const payload=JSON.parse(event.payload_json); delete payload.supplier_id
  db.prepare('UPDATE sync_outbox SET payload_json=? WHERE operation_id=?').run(JSON.stringify(payload),event.operation_id)
  const before=snap(); expect(merge).toThrow(/старих оплат/); expect(snap()).toEqual(before)
  db.prepare("UPDATE sync_outbox SET status='synced' WHERE operation_id=?").run(event.operation_id)
  expect(merge).not.toThrow()
})
it('does not revive the merged supplier via a stale edit', () => {
  merge(); const before = snap()
  expect(() => supply.saveSupplier({ name: 'Old form' }, source)).toThrow()
  expect(snap()).toEqual(before)
})
