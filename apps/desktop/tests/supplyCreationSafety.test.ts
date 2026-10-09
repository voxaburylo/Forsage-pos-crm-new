import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { commitReceiving } from '../src/repositories/receivingCommit'


it('keeps the saved draft, payment and stock unchanged on retry after restart and queue cleanup', () => {
  const input=body(150), saved=supply.createInvoice(input)
  expect(saved).toMatchObject({total:400,paid_amount:150,status:'draft'})
  expect(saved.items).toHaveLength(2)
  expect(db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get('p')).toEqual({qty_on_hand:7})
  db.exec('DELETE FROM sync_outbox');db.close();db=new LocalDatabase(root);supply=new LocalSupplyRepository(db)
  const before=snapshot();expect(supply.createInvoice(input).id).toBe(saved.id);expect(snapshot()).toEqual(before)
})
it('does not restore the original quantity when a creation request is retried after editing', () => {
  const input=body(), saved=supply.createInvoice(input)
  supply.updateInvoice(saved.id,{items:[{product_id:'p',qty:98,purchase_price:100}]})
  const before=snapshot();expect(supply.createInvoice(input).id).toBe(saved.id);expect(snapshot()).toEqual(before)
  expect(supply.getInvoice(saved.id).items[0].qty).toBe(98)
})
it('rejects a changed payload under the same operation ID without writing', () => {
  const input=body();supply.createInvoice(input)
  const before=snapshot();expect(()=>supply.createInvoice({...input,notes:'Changed'})).toThrow('інші дані');expect(snapshot()).toEqual(before)
})
it('checks creation completeness when the caller did not supply an operation ID',()=>{
  db.exec("CREATE TRIGGER skip_line BEFORE INSERT ON supply_invoice_items WHEN NEW.id='line2' BEGIN SELECT RAISE(IGNORE); END")
  const before=snapshot();expect(()=>supply.createInvoice({...body(),operation_id:undefined})).toThrow();expect(snapshot()).toEqual(before)
})
it.each(['header','cash','product','queue'])('detects a late receipt write changing the verified %s',kind=>{
  const sql=kind==='header'?"UPDATE supply_invoices SET notes='Wrong'"
    :kind==='cash'?'UPDATE cash_operations SET amount=amount+1'
    :kind==='product'?'UPDATE products SET qty_on_hand=99'
    :"UPDATE sync_outbox SET payload_json='{}'"
  db.exec("CREATE TRIGGER alter_receipt AFTER INSERT ON app_meta WHEN NEW.key LIKE 'mutation:supply-create:%' BEGIN "+sql+'; END')
  const before=snapshot();expect(()=>supply.createInvoice(body(150))).toThrow();expect(snapshot()).toEqual(before)
})
it('rolls back a late change during the AI receipt write, including new product and supplier',()=>{
  db.exec("CREATE TRIGGER late_ai AFTER INSERT ON app_meta WHEN NEW.key LIKE 'mutation:ai-invoice:%' BEGIN UPDATE supply_invoices SET notes='Wrong'; END")
  const before=snapshot()
  expect(()=>supply.createInvoiceFromAiRows({operation_id:'ai',supplier_name:'New supplier',rows:[
    {name:'Ключ новий TEST 18',sku:'NEW-18',brand:'TestBrand',category:'Ключі',qty:2,purchase_price_uah:100},
  ]})).toThrow()
  expect(snapshot()).toEqual(before)
})
it.each(['time','deleted'])('rejects a %s retry receipt at creation',kind=>{
  const sql=kind==='time'?"UPDATE app_meta SET updated_at='Wrong' WHERE key=NEW.key":'DELETE FROM app_meta WHERE key=NEW.key'
  db.exec("CREATE TRIGGER bad_receipt AFTER INSERT ON app_meta WHEN NEW.key LIKE 'mutation:supply-create:%' BEGIN "+sql+'; END')
  const before=snapshot();expect(()=>supply.createInvoice(body())).toThrow();expect(snapshot()).toEqual(before)
})
it('rejects an extra queued invoice event before committing',()=>{
  db.exec(`CREATE TRIGGER extra_queue AFTER INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice.created' BEGIN
    INSERT INTO sync_outbox(operation_id,tenant_id,device_id,aggregate_type,aggregate_id,operation_type,payload_json,status,created_at)
    VALUES('extra',NEW.tenant_id,NEW.device_id,NEW.aggregate_type,NEW.aggregate_id,NEW.operation_type,NEW.payload_json,'pending',NEW.created_at); END`)
  const before=snapshot();expect(()=>supply.createInvoice(body())).toThrow();expect(snapshot()).toEqual(before)
})
it('preserves fractional quantities, repeated product rows and a free line without stock movement',()=>{
  const input={...body(),items:[{id:'a',product_id:'p',qty:0.125,purchase_price:1000},{id:'b',product_id:'p',qty:2,purchase_price:0}]}
  const saved=supply.createInvoice(input)
  expect(saved.total).toBe(125);expect(saved.items.map((x:any)=>[x.id,x.qty,x.purchase_price,x.total])).toEqual([['a',0.125,1000,125],['b',2,0,0]])
  expect(db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get('p')).toEqual({qty_on_hand:7})
})
it.each(['duplicate line ID','other document line ID','other document ID'])('rejects %s without altering existing documents',kind=>{
  const saved=supply.createInvoice({...body(),id:'old',operation_id:'old-op',items:[{id:'old-line',product_id:'p',qty:1,purchase_price:100}]})
  const input=body()
  if(kind==='duplicate line ID') input.items[1].id=input.items[0].id
  if(kind==='other document line ID') input.items[1].id='old-line'
  if(kind==='other document ID') input.id=saved.id
  const before=snapshot();expect(()=>supply.createInvoice(input)).toThrow();expect(snapshot()).toEqual(before)
})
it('preserves all rows of a large invoice exactly',()=>{
  const input={...body(),items:Array.from({length:500},(_,i)=>({id:'line-'+i,product_id:'p',qty:i%7+1,purchase_price:100+i}))}
  const saved=supply.createInvoice(input)
  expect(saved.items).toHaveLength(500)
  const byId=new Map(saved.items.map((row:any)=>[row.id,row]))
  for(const row of input.items) expect(byId.get(row.id)).toMatchObject(row)
  const before=snapshot();supply.createInvoice(input);expect(snapshot()).toEqual(before)
})

it.each([false, true])('rolls back complete receiving and stock when its receipt is skipped, paid=%s', paid => {
  db.exec("CREATE TRIGGER skip_receiving BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'mutation:receiving:%' BEGIN SELECT RAISE(IGNORE); END")
  const input = {operation_id:'receive',invoice_id:'received',supplier_id:'supplier',user_id:'owner',
    items:[{client_key:'r1',product_id:'p',product_name:'Fixture',sku:'TEST',qty:2,purchase_price:100,retail_price:0}],
    payments:paid?[{amount:100,payment_method:'cash' as const,fund_source:'cashbox' as const,shift_id:'shift'}]:[]}
  const before=snapshot();expect(()=>commitReceiving(db,input)).toThrow();expect(snapshot()).toEqual(before)
  db.exec('DROP TRIGGER skip_receiving')
  expect(commitReceiving(db,input).status).toBe('posted')
  expect(db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get('p')).toEqual({qty_on_hand:9})
  const after=snapshot();commitReceiving(db,input);expect(snapshot()).toEqual(after)
})

let root: string, db: LocalDatabase, supply: LocalSupplyRepository
const at = '2026-10-08T09:00:00.000Z'
const body = (paid = 0) => ({
  id: 'invoice', operation_id: 'create-once', supplier_id: 'supplier', invoice_number: 'TEST', notes: 'Original',
  paid_amount: paid, payment_method: 'cash' as const, fund_source: 'cashbox' as const, shift_id: 'shift', user_id: 'owner',
  items: [{id: 'line1', product_id: 'p', qty: 2, purchase_price: 100}, {id: 'line2', product_id: 'p', qty: 1, purchase_price: 200}],
})
const snapshot = () => Object.fromEntries(['products','product_barcodes','categories','brands','suppliers','supply_invoices','supply_invoice_items','supplier_payments','cash_operations','inventory_movements','sync_outbox','app_meta']
  .map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-supply-create-'))
  db = new LocalDatabase(root); supply = new LocalSupplyRepository(db)
  db.prepare('INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,created_at,updated_at) VALUES(?,?,?,?,7,?,?)').run('p',tenant,'TEST','Fixture',at,at)
  db.prepare('INSERT INTO suppliers(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('supplier',tenant,'Fixture',at,at)
  db.prepare('INSERT INTO shifts(id,tenant_id,cashier_id,opening_cash,opened_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('shift',tenant,'owner',10000,at,at,at)
})
afterEach(() => {
  db.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-supply-create-')) rmSync(root, {recursive:true,force:true})
})
it.each(['header','one line','all lines','queue','receipt'])('rolls back silently skipped creation %s', kind => {
  const table = kind === 'header' ? 'supply_invoices' : kind.includes('line') ? 'supply_invoice_items' : kind === 'queue' ? 'sync_outbox' : 'app_meta'
  const when = kind === 'one line' ? " WHEN NEW.id='line2'" : kind === 'receipt' ? " WHEN NEW.key LIKE 'mutation:supply-create:%'" : ''
  db.exec('CREATE TRIGGER skip_create BEFORE INSERT ON ' + table + when + ' BEGIN SELECT RAISE(IGNORE); END')
  const before = snapshot()
  expect(() => supply.createInvoice(body())).toThrow()
  expect(snapshot()).toEqual(before)
  db.exec('DROP TRIGGER skip_create')
  expect(supply.createInvoice(body()).items).toHaveLength(2)
})
it.each(['header','line values','line reassignment','queue payload','queue status','late header','late line','receipt body','receipt late line'])('rejects altered creation %s', kind => {
  const trigger = kind === 'header' ? "AFTER INSERT ON supply_invoices BEGIN UPDATE supply_invoices SET notes='Wrong' WHERE id=NEW.id; END"
    : kind === 'line values' ? "AFTER INSERT ON supply_invoice_items WHEN NEW.id='line1' BEGIN UPDATE supply_invoice_items SET qty=1,purchase_price=200 WHERE id=NEW.id; END"
    : kind === 'line reassignment' ? "AFTER INSERT ON supply_invoice_items WHEN NEW.id='line2' BEGIN UPDATE supply_invoice_items SET tenant_id='other' WHERE id=NEW.id; END"
    : kind === 'queue payload' ? "AFTER INSERT ON sync_outbox BEGIN UPDATE sync_outbox SET payload_json='{}' WHERE operation_id=NEW.operation_id; END"
    : kind === 'queue status' ? "AFTER INSERT ON sync_outbox BEGIN UPDATE sync_outbox SET status='synced' WHERE operation_id=NEW.operation_id; END"
    : kind === 'late header' ? "AFTER INSERT ON sync_outbox BEGIN UPDATE supply_invoices SET notes='Wrong'; END"
    : kind === 'late line' ? "AFTER INSERT ON sync_outbox BEGIN UPDATE supply_invoice_items SET qty=1,purchase_price=200 WHERE id='line1'; END"
    : kind === 'receipt body' ? "AFTER INSERT ON app_meta WHEN NEW.key LIKE 'mutation:supply-create:%' BEGIN UPDATE app_meta SET value_json='{}' WHERE key=NEW.key; END"
    : "AFTER INSERT ON app_meta WHEN NEW.key LIKE 'mutation:supply-create:%' BEGIN UPDATE supply_invoice_items SET qty=1,purchase_price=200 WHERE id='line1'; END"
  db.exec('CREATE TRIGGER alter_create ' + trigger)
  const before = snapshot(); expect(() => supply.createInvoice(body())).toThrow(); expect(snapshot()).toEqual(before)
})
it.each(['queue','receipt'])('rolls back initial cash payment if creation %s is missing',kind=>{
  const table = kind === 'queue' ? 'sync_outbox' : 'app_meta'
  db.exec('CREATE TRIGGER skip_paid BEFORE INSERT ON '+table+" BEGIN SELECT RAISE(IGNORE); END")
  const before=snapshot();expect(()=>supply.createInvoice(body(150))).toThrow();expect(snapshot()).toEqual(before)
})
it.each(['queue','receipt'])('rolls back AI draft and new catalog cards if %s is missing', kind=>{
  const table=kind==='queue'?'sync_outbox':'app_meta'
  const when=kind==='queue'?"NEW.operation_type='supplier_invoice.created'":"NEW.key LIKE 'mutation:ai-invoice:%'"
  db.exec('CREATE TRIGGER skip_ai BEFORE INSERT ON '+table+' WHEN '+when+' BEGIN SELECT RAISE(IGNORE); END')
  const before=snapshot()
  expect(()=>supply.createInvoiceFromAiRows({operation_id:'ai',supplier_name:'New supplier',rows:[
    {name:'Ключ новий TEST 18',sku:'NEW-18',brand:'TestBrand',category:'Ключі',qty:2,purchase_price_uah:100},
  ]})).toThrow()
  expect(snapshot()).toEqual(before)
})
