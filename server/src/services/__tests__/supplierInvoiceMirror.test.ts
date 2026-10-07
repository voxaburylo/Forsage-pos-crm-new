import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest'
const state = vi.hoisted(() => ({ db: null as any, fail: '', queries: [] as string[] }))
vi.mock('../../db/pg.js', () => ({ runTransaction: (fn: any) => state.db.transaction((tx: any) => fn({
  query: async (sql: string, args: any[]) => {
    state.queries.push(sql)
    if (state.fail && sql.includes(state.fail)) throw Error('injected storage failure')
    const r = await tx.query(sql, args); return { ...r, rowCount: r.rows.length || r.affectedRows || 0 }
  },
})) }))
vi.mock('../../db/supabase.js', () => ({ db: { rpc: () => { throw Error('stock RPC forbidden') } } }))
import { applySupplierInvoiceCreated, applySupplierInvoiceUpdated, applySupplierInvoicePosted, applySupplierInvoiceCancelled, applySupplierInvoiceDeleted, applySupplierInvoicePaymentAdded } from '../sync/supplierHandlers.js'
import { applySupplierMerged } from '../sync/supplierHandlers.js'
const tenant = randomUUID(), other = randomUUID(), actor = randomUUID(), uploader = randomUUID()
const product = randomUUID(), second = randomUUID(), supplier = randomUUID(), shift = randomUUID()
const at = '2026-09-28T12:00:00.000Z', applied = '2026-10-05T12:00:00.000Z'
const rows = async (sql: string, args: any[] = []) => (await state.db.query(sql, args)).rows as any[]
function operation(paid = 0): any {
  const id = randomUUID()
  return { sequence: 1, operation_id: randomUUID(), aggregate_id: id, aggregate_type: 'supply_invoice',
    operation_type: 'supplier_invoice.created', tenant_id: tenant, device_id: 'primary',
    created_at: applied, applied_at: applied, balance_mirrored: true,
    payload: { id, supplier_id: supplier, invoice_number: 'TEST-25', notes: 'Історичний прихід',
      total: 200, paid_amount: paid, payment_id: paid ? randomUUID() : null, payment_method: paid ? 'cash' : null,
      fund_source: paid ? 'cashbox' : 'bank_account', shift_id: paid ? shift : null, user_id: actor, created_at: at,
      items: [{ id: randomUUID(), product_id: product, qty: 2, purchase_price: 100, total: 200, created_at: at }] } }
}
const apply = (op: any) => applySupplierInvoiceCreated(tenant, uploader, op)
beforeAll(async () => {
  state.db = new PGlite()
  await state.db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_app_meta_data jsonb);
    CREATE TABLE sync_deletions(tenant_id uuid,entity_type text,entity_id uuid);
    CREATE TABLE products(id uuid PRIMARY KEY,tenant_id uuid,purchase_price int,qty_on_hand numeric,deleted_at timestamptz);
    CREATE TABLE suppliers(id uuid PRIMARY KEY,tenant_id uuid,deleted_at timestamptz,is_active boolean DEFAULT true,updated_at timestamptz);
    CREATE TABLE shifts(id uuid PRIMARY KEY,tenant_id uuid,status text,opening_cash int);
    CREATE TABLE supply_invoices(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,supplier_id uuid REFERENCES suppliers,invoice_number varchar(100),status text,total int NOT NULL,paid_amount int,payment_method text,notes text,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz,posted_by uuid,posted_at timestamptz,draft_payload jsonb,draft_saved_at timestamptz,draft_saved_by uuid);
    CREATE TABLE supply_invoice_items(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,invoice_id uuid NOT NULL REFERENCES supply_invoices,product_id uuid NOT NULL REFERENCES products,qty numeric(12,3) NOT NULL,purchase_price int NOT NULL,total int NOT NULL,created_at timestamptz NOT NULL,deleted_at timestamptz);
    CREATE TABLE supplier_payments(id uuid PRIMARY KEY,tenant_id uuid,invoice_id uuid REFERENCES supply_invoices,supplier_id uuid REFERENCES suppliers,amount int NOT NULL,payment_method text,fund_source text,shift_id uuid REFERENCES shifts,note text,created_by uuid NOT NULL,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz);
    CREATE TABLE cash_operations(id uuid PRIMARY KEY,tenant_id uuid,shift_id uuid,type text,amount int,note text,source text,created_by uuid,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz,sale_id uuid,employee_id uuid,work_date date);
  `)
})
const migration = readFileSync(new URL('../../../../supabase/migrations/20261005170920_supplier_invoice_copy_receipts.sql', import.meta.url), 'utf8')
beforeAll(async () => {
  await state.db.exec(migration)
  await state.db.exec(readFileSync(new URL('../../../../supabase/migrations/20261006081852_supplier_empty_merge_receipts.sql', import.meta.url), 'utf8'))
  await state.db.exec(readFileSync(new URL('../../../../supabase/migrations/20261006060854_supplier_invoice_terminal_receipts.sql', import.meta.url), 'utf8'))
  await state.db.exec(readFileSync(new URL('../../../../supabase/migrations/20261006091417_supplier_history_merge_receipts.sql', import.meta.url), 'utf8'))
})
afterAll(async () => state.db.close())
beforeEach(async () => {
  state.fail = ''; state.queries = []
  await state.db.exec('TRUNCATE sync_deletions,supplier_invoice_copy_receipts,cash_operations,supplier_payments,supply_invoice_items,supply_invoices,products,suppliers,shifts,auth.users CASCADE')
  await state.db.query('INSERT INTO products VALUES($1,$2,999,0,NULL),($3,$2,999,0,NULL)', [product, tenant, second])
  await state.db.query('INSERT INTO suppliers(id,tenant_id,deleted_at) VALUES($1,$2,NULL)', [supplier, tenant])
  await state.db.query("INSERT INTO shifts VALUES($1,$2,'closed',0)", [shift, tenant])
  await state.db.query("INSERT INTO auth.users VALUES($1,jsonb_build_object('tenant_id',$2::text))", [actor, tenant])
})
function paymentOperation(invoice: any, amount = 75): any {
  return { ...invoice, operation_id: randomUUID(), sequence: 2, operation_type: 'supplier_invoice.payment_added',
    payload: { id: invoice.aggregate_id, payment_id: randomUUID(), supplier_id: supplier, amount,
      payment_method: 'cash', fund_source: 'cashbox', shift_id: shift, note: 'Доплата', user_id: actor, created_at: at } }
}
const pay = (op: any) => applySupplierInvoicePaymentAdded(tenant, uploader, op)


const terminalAt = '2026-09-29T08:00:00.000Z'
function terminal(a: any, kind: 'cancelled' | 'deleted' = 'cancelled', posted = false): any {
  return { ...a, sequence: a.sequence + 1, operation_id: randomUUID(), operation_type: 'supplier_invoice.' + kind,
    payload: { id: a.aggregate_id, created_at: terminalAt,
      previous_invoice: posted ? a.payload.invoice_snapshot : snapshot(a), previous_status: posted ? 'posted' : 'draft',
      posted_by: posted ? actor : null, posted_at: posted ? postedAt : null } }
}
const finish = (op: any) => op.operation_type === 'supplier_invoice.deleted'
  ? applySupplierInvoiceDeleted(tenant, op) : applySupplierInvoiceCancelled(tenant, op)

const mergeApply = (op: any) => applySupplierMerged(tenant, op)
async function historyMerge(invoiceIds: string[], sourceId = supplier, destination = randomUUID()): Promise<any> {
  await state.db.query('INSERT INTO suppliers(id,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[destination,tenant])
  const invoices = []
  for (const id of invoiceIds) {
    const i = (await rows('SELECT * FROM supply_invoices WHERE id=$1',[id]))[0]
    const items = await rows('SELECT * FROM supply_invoice_items WHERE invoice_id=$1 ORDER BY id',[id])
    const payments = await rows('SELECT * FROM supplier_payments WHERE invoice_id=$1 ORDER BY id',[id])
    invoices.push({id,status:i.deleted_at?'deleted':i.status,...(i.deleted_at?{deleted_at:i.deleted_at.toISOString()}:{}),posted_by:i.posted_by,posted_at:i.posted_at?.toISOString() ?? null,paid_amount:i.paid_amount,payment_method:i.payment_method,
      snapshot:{supplier_id:i.supplier_id,invoice_number:i.invoice_number,notes:i.notes,total:i.total,created_at:i.created_at.toISOString(),
        items:items.map(l=>({id:l.id,product_id:l.product_id,qty:Number(l.qty),purchase_price:l.purchase_price,total:l.total,created_at:l.created_at.toISOString()}))},
      payments:payments.map(p=>({id:p.id,invoice_id:p.invoice_id,supplier_id:p.supplier_id,amount:p.amount,payment_method:p.payment_method,
        fund_source:p.fund_source,shift_id:p.shift_id,note:p.note,created_by:p.created_by,created_at:p.created_at.toISOString()}))})
  }
  return {tenant_id:tenant,operation_id:randomUUID(),device_id:'primary',sequence:100,aggregate_id:destination,aggregate_type:'supplier',operation_type:'supplier.merged',created_at:applied,
    payload:{history_version:1,primary_supplier_id:destination,duplicate_supplier_id:sourceId,invoices}}
}
const mergeState = async () => Promise.all(['suppliers','supply_invoices','supply_invoice_items','supplier_payments','cash_operations','products','supplier_merge_receipts','supplier_invoice_copy_receipts']
  .map(t=>rows('SELECT * FROM '+t+' ORDER BY '+(t==='supplier_merge_receipts'?'duplicate_id':t==='supplier_invoice_copy_receipts'?'receipt_no':'id'))))

describe('deleted supplier history transfer', () => {
  it('keeps a deleted invoice and its lines hidden through two transfers and all old retries', async () => {
    const a=operation();await apply(a);const d=terminal(a,'deleted');await finish(d)
    const originals=await receipts(),lines=await lineRows(),cash=await rows('SELECT * FROM cash_operations'),stock=await rows('SELECT * FROM products')
    const m=await historyMerge([a.aggregate_id]);await mergeApply(m)
    const m2=await historyMerge([a.aggregate_id],m.aggregate_id);m2.sequence=200;await mergeApply(m2)
    expect((await invoiceRows())[0]).toMatchObject({supplier_id:m2.aggregate_id,deleted_at:new Date(terminalAt),status:'draft',paid_amount:0})
    expect((await receipts()).slice(0,originals.length)).toEqual(originals)
    const before=await mergeState()
    await apply(a);await finish(d);await mergeApply(m);await mergeApply(m2);expect(await mergeState()).toEqual(before)
    expect(await lineRows()).toEqual(lines);expect(await rows('SELECT * FROM cash_operations')).toEqual(cash);expect(await rows('SELECT * FROM products')).toEqual(stock)
    expect(await rows('SELECT * FROM supply_invoices WHERE deleted_at IS NULL')).toHaveLength(0)
  })
  it('retains deleted content after an edit and acknowledges the exact old edit', async () => {
    const a=operation();await apply(a);const e=edit(a);await update(e)
    const d=terminal(e,'deleted');d.payload.previous_invoice.created_at=a.payload.created_at;await finish(d)
    const m=await historyMerge([a.aggregate_id]);await mergeApply(m)
    const before=await mergeState();await update(e);await finish(d);await apply(a);await mergeApply(m);expect(await mergeState()).toEqual(before)
  })
  it('supports merged draft, later deletion and a further merge with original retries', async () => {
    const a=operation();await apply(a);const m=await historyMerge([a.aggregate_id]);await mergeApply(m)
    const d=terminal(a,'deleted');d.sequence=101;d.payload.previous_invoice.supplier_id=m.aggregate_id;await finish(d)
    const m2=await historyMerge([a.aggregate_id],m.aggregate_id);m2.sequence=200;await mergeApply(m2)
    const before=await mergeState();await apply(a);await finish(d);await mergeApply(m);await mergeApply(m2);expect(await mergeState()).toEqual(before)
  })
  it('moves deleted and live history together without changing financial or stock totals', async () => {
    const a=operation(),b=operation(50),c=operation(),d=operation()
    for(const op of [a,b,c,d]) await apply(op)
    await finish(terminal(a,'deleted'));await posting(post(b));await finish(terminal(c))
    const m=await historyMerge([a.aggregate_id,b.aggregate_id,c.aggregate_id,d.aggregate_id]),old=await invoiceRows()
    await mergeApply(m);expect((await invoiceRows()).map(i=>[i.id,i.status,i.deleted_at,i.total,i.paid_amount])).toEqual(old.map(i=>[i.id,i.status,i.deleted_at,i.total,i.paid_amount]))
    const before=await mergeState();await mergeApply(m);expect(await mergeState()).toEqual(before)
  })
  it.each(['missing deletion date','unexpected deletion date','wrong deletion date','paid deleted','posted deleted','missing receipt','changed snapshot','extra deleted document','foreign deleted document'])('rejects invalid deleted transfer: %s', async kind => {
    const a=operation();await apply(a);await finish(terminal(a,'deleted'))
    const m=await historyMerge([a.aggregate_id]),copy=m.payload.invoices[0]
    if(kind==='missing deletion date') delete copy.deleted_at
    if(kind==='unexpected deletion date') copy.status='draft'
    if(kind==='wrong deletion date') copy.deleted_at=applied
    if(kind==='paid deleted') {copy.paid_amount=1;copy.payment_method='cash'}
    if(kind==='posted deleted') copy.posted_at=at
    if(kind==='missing receipt') await state.db.exec('DELETE FROM supplier_invoice_copy_receipts')
    if(kind==='changed snapshot') await state.db.exec("UPDATE supply_invoices SET notes='damaged'")
    if(kind==='extra deleted document') {const b=operation();b.sequence=3;await apply(b);await finish(terminal(b,'deleted'))}
    if(kind==='foreign deleted document') copy.id=randomUUID()
    const before=await mergeState();await expect(mergeApply(m)).rejects.toBeDefined();expect(await mergeState()).toEqual(before)
  })
  it.each(['create','edit','post','pay','cancel','delete'])('does not accept a new %s request for an already deleted merged invoice', async kind => {
    const a=operation();await apply(a);await finish(terminal(a,'deleted'));const m=await historyMerge([a.aggregate_id]);await mergeApply(m)
    let op:any
    if(kind==='create') op={...a,operation_id:randomUUID()}
    else op=kind==='edit'?edit(a):kind==='post'?post(a):kind==='pay'?paymentOperation(a):terminal(a,kind==='delete'?'deleted':'cancelled')
    op.sequence=101
    if(kind==='create'||kind==='edit'||kind==='pay') op.payload.supplier_id=m.aggregate_id
    if(kind==='post') op.payload.invoice_snapshot.supplier_id=m.aggregate_id
    if(kind==='delete'||kind==='cancel') op.payload.previous_invoice.supplier_id=m.aggregate_id
    const before=await mergeState()
    await expect(kind==='create'?apply(op):kind==='edit'?update(op):kind==='post'?posting(op):kind==='pay'?pay(op):finish(op)).rejects.toBeDefined()
    expect(await mergeState()).toEqual(before)
  })
  it.each(['revived','changed deleted date','changed line','missing merged receipt'])('refuses deleted replay corruption: %s', async kind => {
    const a=operation();await apply(a);await finish(terminal(a,'deleted'));const m=await historyMerge([a.aggregate_id]);await mergeApply(m)
    if(kind==='revived') await state.db.exec('UPDATE supply_invoices SET deleted_at=NULL')
    if(kind==='changed deleted date') await state.db.query('UPDATE supply_invoices SET deleted_at=$1',[applied])
    if(kind==='changed line') await state.db.exec('UPDATE supply_invoice_items SET qty=3,total=300;UPDATE supply_invoices SET total=300')

    if(kind==='missing merged receipt') await state.db.exec("DELETE FROM supplier_invoice_copy_receipts WHERE operation_type='supplier_invoice.supplier_merged'")
    const before=await mergeState();await expect(mergeApply(m)).rejects.toBeDefined();expect(await mergeState()).toEqual(before)
  })
  it.each(['UPDATE supply_invoices SET supplier_id','INSERT INTO supplier_invoice_copy_receipts','UPDATE suppliers SET deleted_at','INSERT INTO supplier_merge_receipts'])('rolls back deleted transfer if %s fails', async fail => {
    const a=operation(),b=operation();await apply(a);await apply(b);await finish(terminal(a,'deleted'))
    const m=await historyMerge([a.aggregate_id,b.aggregate_id]),before=await mergeState();state.fail=fail
    await expect(mergeApply(m)).rejects.toThrow('injected storage failure');expect(await mergeState()).toEqual(before)
  })
})

describe('draft and cancelled supplier history transfer', () => {
  it.each([0,50,200])('moves a draft with %i paid and preserves old acknowledgements', async paid => {
    const a=operation(paid); await apply(a)
    const m=await historyMerge([a.aggregate_id]), cash=await rows('SELECT * FROM cash_operations'), stock=await rows('SELECT * FROM products')
    await mergeApply(m)
    expect((await invoiceRows())[0]).toMatchObject({status:'draft',supplier_id:m.aggregate_id,paid_amount:paid})
    const before=await mergeState(); await mergeApply(m); await apply(a); expect(await mergeState()).toEqual(before)
    expect(await rows('SELECT * FROM cash_operations')).toEqual(cash);expect(await rows('SELECT * FROM products')).toEqual(stock)
  })
  it.each([false,true])('moves cancelled history (originally posted=%s), preserving exact old retries through two merges', async posted => {
    const a=operation();await apply(a);const p=post(a);if(posted) await posting(p)
    const t=terminal(structuredClone(posted?p:a),'cancelled',posted);await finish(t)
    const oldReceipts=await receipts(),m=await historyMerge([a.aggregate_id])
    const stock=await rows('SELECT * FROM products'),cash=await rows('SELECT * FROM cash_operations')
    await mergeApply(m);const m2=await historyMerge([a.aggregate_id],m.aggregate_id);m2.sequence=200;await mergeApply(m2)
    expect((await invoiceRows())[0]).toMatchObject({status:'cancelled',supplier_id:m2.aggregate_id,paid_amount:0})
    expect((await receipts()).slice(0,oldReceipts.length)).toEqual(oldReceipts)
    const before=await mergeState()
    await apply(a);if(posted) await posting(p);await finish(t);await mergeApply(m);await mergeApply(m2)
    expect(await mergeState()).toEqual(before)
    expect(await rows('SELECT * FROM products')).toEqual(stock);expect(await rows('SELECT * FROM cash_operations')).toEqual(cash)
  })
  it.each(['cancel','delete','post','edit','reassign','clear supplier'])('supports %s after merged draft, then repeats original create/merge', async action => {
    const a=operation();await apply(a);const m=await historyMerge([a.aggregate_id]);await mergeApply(m)
    if(action==='cancel'||action==='delete') {
      const t=terminal(a,action==='delete'?'deleted':'cancelled');t.sequence=101;t.payload.previous_invoice.supplier_id=m.aggregate_id;await finish(t)
    }
    if(action==='post') {const p=post(a);p.sequence=101;p.payload.invoice_snapshot.supplier_id=m.aggregate_id;await posting(p)}
    if(['edit','reassign','clear supplier'].includes(action)) {
      const e=edit(a);e.sequence=101;e.payload.previous_invoice.supplier_id=m.aggregate_id;e.payload.supplier_id=m.aggregate_id
      if(action==='reassign') {e.payload.supplier_id=randomUUID();await state.db.query('INSERT INTO suppliers(id,tenant_id) VALUES($1,$2)',[e.payload.supplier_id,tenant])}
      if(action==='clear supplier') e.payload.supplier_id=null
      await update(e)
    }
    const before=await mergeState();await apply(a);await mergeApply(m);expect(await mergeState()).toEqual(before)
    if(action==='delete') expect((await invoiceRows())[0].deleted_at).not.toBeNull()
  })
  it.each(['edit','post','pay','cancel','delete'])('rejects stale %s on old supplier after draft transfer', async action => {
    const a=operation();await apply(a);const m=await historyMerge([a.aggregate_id]);await mergeApply(m)
    const op=action==='edit'?edit(a):action==='post'?post(a):action==='pay'?paymentOperation(a):terminal(a,action==='delete'?'deleted':'cancelled')
    op.sequence=101
    const before=await mergeState()
    await expect(action==='edit'?update(op):action==='post'?posting(op):action==='pay'?pay(op):finish(op)).rejects.toBeDefined()
    expect(await mergeState()).toEqual(before)
  })
  it.each(['paid cancelled','posted draft','deleted without proof','changed cancelled'])('refuses inconsistent %s atomically', async kind => {
    const a=operation(kind==='paid cancelled'?50:0);await apply(a)
    if(kind==='deleted without proof') {await finish(terminal(a,'deleted'));await state.db.exec('DELETE FROM supplier_invoice_copy_receipts')}
    if(kind==='changed cancelled') await finish(terminal(a))
    if(kind==='paid cancelled') await state.db.exec("UPDATE supply_invoices SET status='cancelled'")
    if(kind==='posted draft') await state.db.query('UPDATE supply_invoices SET posted_at=$1,posted_by=$2',[at,actor])
    if(kind==='changed cancelled') await state.db.exec("UPDATE supply_invoices SET notes='damaged'")
    const m=await historyMerge([a.aggregate_id]),before=await mergeState()
    await expect(mergeApply(m)).rejects.toBeDefined();expect(await mergeState()).toEqual(before)
  })
  it('transfers a mixed set of draft, paid posted and cancelled without changing any amounts', async () => {
    const a=operation(),b=operation(50),c=operation();await apply(a);await apply(b);await apply(c)
    await posting(post(b));await finish(terminal(c))
    const m=await historyMerge([a.aggregate_id,b.aggregate_id,c.aggregate_id]), old=await invoiceRows()
    await mergeApply(m)
    expect((await invoiceRows()).map(i=>[i.id,i.status,i.total,i.paid_amount])).toEqual(old.map(i=>[i.id,i.status,i.total,i.paid_amount]))
    expect((await invoiceRows()).every(i=>i.supplier_id===m.aggregate_id)).toBe(true)
  })
  it('rolls back the entire mixed transfer if the final receipt fails', async () => {
    const a=operation(),b=operation();await apply(a);await apply(b);await finish(terminal(b))
    const m=await historyMerge([a.aggregate_id,b.aggregate_id]),before=await mergeState();state.fail='INSERT INTO supplier_merge_receipts'
    await expect(mergeApply(m)).rejects.toThrow('injected storage failure');expect(await mergeState()).toEqual(before)
  })
})

describe('posted supplier history transfer', () => {
  it.each([0,50,200])('moves invoice with %i paid once; old creation/posting/payment replay does not spend again', async paid => {
    const a=operation(paid); await apply(a); const p=post(a); await posting(p)
    const payment=paid===50?paymentOperation(a):null
    if(payment) await pay(payment)
    const cash=await rows('SELECT * FROM cash_operations ORDER BY id'), stock=await rows('SELECT * FROM products ORDER BY id'), lines=await lineRows()
    const m=await historyMerge([a.aggregate_id]); await mergeApply(m)
    expect((await invoiceRows())[0]).toMatchObject({supplier_id:m.aggregate_id,paid_amount:paid+(payment?75:0),total:200,status:'posted'})
    expect((await receipts()).at(-1).operation_type).toBe('supplier_invoice.supplier_merged')
    const before=await mergeState()
    await mergeApply(m); await apply(a); await posting(p); if(payment) await pay(payment)
    expect(await mergeState()).toEqual(before)
    expect(await rows('SELECT * FROM cash_operations ORDER BY id')).toEqual(cash)
    expect(await rows('SELECT * FROM products ORDER BY id')).toEqual(stock); expect(await lineRows()).toEqual(lines)
  })
  it('preserves historical payment identity through two merges and accepts a new payment only on current supplier', async () => {
    const a=operation(50); await apply(a); const p=post(a); await posting(p)
    const old=paymentOperation(a); await pay(old)
    const m=await historyMerge([a.aggregate_id]); await mergeApply(m)
    const next=paymentOperation(a,25); next.sequence=101; next.payload.supplier_id=m.aggregate_id; await pay(next)
    const m2=await historyMerge([a.aggregate_id],m.aggregate_id); m2.sequence=200; await mergeApply(m2)
    const before=await mergeState(); await apply(a); await pay(old); await pay(next); await mergeApply(m); await mergeApply(m2); expect(await mergeState()).toEqual(before)
    const stale=paymentOperation(a,10); stale.sequence=201
    await expect(pay(stale)).rejects.toMatchObject({status:409})
    const forged=structuredClone(next); forged.payload.supplier_id=supplier
    await expect(pay(forged)).rejects.toMatchObject({status:409})
    expect(await mergeState()).toEqual(before)
  })
  it.each(['cashbox','owner_funds','bank_account','business_card'])('does not change money from %s', async fund => {
    const a=operation(); await apply(a); await posting(post(a))
    const p=paymentOperation(a); p.payload.fund_source=fund
    if(fund!=='cashbox') {p.payload.shift_id=null; p.payload.payment_method='transfer'}
    await pay(p)
    const cash=await rows('SELECT * FROM cash_operations')
    const m=await historyMerge([a.aggregate_id]); await mergeApply(m); await pay(p)
    expect(await rows('SELECT * FROM cash_operations')).toEqual(cash)
    expect((await invoiceRows())[0].paid_amount).toBe(75)
  })
  it.each(['amount','note','actor','supplier','line','status','foreign invoice','foreign payment','extra invoice','missing payment','orphan payment'])('rejects history mismatch: %s atomically', async kind => {
    const a=operation(50); await apply(a); await posting(post(a))
    const m=await historyMerge([a.aggregate_id]), i=m.payload.invoices[0]
    if(kind==='amount') {i.payments[0].amount=60; i.paid_amount=60}
    if(kind==='note') i.payments[0].note='forged'
    if(kind==='actor') i.payments[0].created_by=uploader
    if(kind==='supplier') i.snapshot.supplier_id=m.aggregate_id
    if(kind==='line') {i.snapshot.items[0].qty=3; i.snapshot.items[0].total=300; i.snapshot.total=300}
    if(kind==='status') await state.db.exec("UPDATE supply_invoices SET status='draft'")
    if(kind==='foreign invoice') m.tenant_id=other
    if(kind==='foreign payment') await state.db.query('UPDATE supplier_payments SET tenant_id=$1',[other])
    if(kind==='extra invoice') {const b=operation(); await apply(b); await posting(post(b))}
    if(kind==='missing payment') {i.payments=[]; i.paid_amount=0; i.payment_method=null}
    if(kind==='orphan payment') await state.db.query('UPDATE supplier_payments SET supplier_id=$1',[m.aggregate_id])
    const before=await mergeState(); await expect(mergeApply(m)).rejects.toBeDefined(); expect(await mergeState()).toEqual(before)
  })
  it.each(['payload','sequence','device','operation','tombstone','current state'])('rejects corrupted merge replay %s', async kind => {
    const a=operation(50); await apply(a); await posting(post(a))
    const m=await historyMerge([a.aggregate_id]); await mergeApply(m)
    if(kind==='payload') m.payload.invoices[0].snapshot.notes='forged'
    if(kind==='sequence') m.sequence++
    if(kind==='device') m.device_id='other'
    if(kind==='operation') m.operation_id=randomUUID()
    if(kind==='tombstone') await state.db.query('UPDATE suppliers SET deleted_at=NULL WHERE id=$1',[supplier])
    if(kind==='current state') await state.db.exec("UPDATE supply_invoices SET notes='damaged'")
    const before=await mergeState(); await expect(mergeApply(m)).rejects.toBeDefined(); expect(await mergeState()).toEqual(before)
  })
  it.each(['UPDATE supply_invoices SET supplier_id','UPDATE supplier_payments SET supplier_id','INSERT INTO supplier_invoice_copy_receipts','UPDATE suppliers SET deleted_at','INSERT INTO supplier_merge_receipts'])('rolls back all transfer facts on %s failure', async fail => {
    const a=operation(50); await apply(a); await posting(post(a))
    const m=await historyMerge([a.aggregate_id]), before=await mergeState(); state.fail=fail
    await expect(mergeApply(m)).rejects.toThrow('injected storage failure'); expect(await mergeState()).toEqual(before)
    state.fail=''; await mergeApply(m); await mergeApply(m)
  })
  it('does not let a stale invoice creation attach the archived source', async () => {
    const a=operation(); await apply(a); await posting(post(a))
    const m=await historyMerge([a.aggregate_id]); await mergeApply(m)
    const before=await mergeState(); await expect(apply(operation())).rejects.toBeDefined(); expect(await mergeState()).toEqual(before)
  })
  it('supports cancellation after merge and then acknowledges original creation, posting and merge', async () => {
    const a=operation(); await apply(a); const p=post(a); await posting(p)
    const m=await historyMerge([a.aggregate_id]); await mergeApply(m)
    const t=terminal(structuredClone(p),'cancelled',true); t.sequence=101; t.payload.previous_invoice.supplier_id=m.aggregate_id; await finish(t)
    const before=await mergeState(); await apply(a); await posting(p); await mergeApply(m); expect(await mergeState()).toEqual(before)
  })
  it('checks complete multi-invoice set and never moves the target history', async () => {
    const a=operation(25), b=operation(50); await apply(a); await apply(b); await posting(post(a)); await posting(post(b))
    const m=await historyMerge([b.aggregate_id,a.aggregate_id]); await mergeApply(m)
    expect((await invoiceRows()).map(i=>i.supplier_id)).toEqual([m.aggregate_id,m.aggregate_id])
    expect((await rows('SELECT SUM(paid_amount) p,SUM(total-paid_amount) debt FROM supply_invoices'))[0]).toEqual({p:75,debt:325})
    const before=await mergeState(); await mergeApply(m); expect(await mergeState()).toEqual(before)
  })
  it('refuses unknown references even alongside a complete posted history', async () => {
    const a=operation(); await apply(a); await posting(post(a)); const m=await historyMerge([a.aggregate_id])
    await state.db.exec('CREATE TABLE future_supplier_links(vendor_ref uuid REFERENCES suppliers(id),tenant_id uuid)')
    try {
      await state.db.query('INSERT INTO future_supplier_links VALUES($1,$2)',[supplier,other])
      const before=await mergeState(); await expect(mergeApply(m)).rejects.toMatchObject({status:409}); expect(await mergeState()).toEqual(before)
    } finally { await state.db.exec('DROP TABLE future_supplier_links') }
  })
  it.each(['invalid operation','same cards','duplicate invoice','duplicate payment','bad payment method'])('rejects malformed transfer %s before writing', async kind => {
    const a=operation(50); await apply(a); await posting(post(a)); const m=await historyMerge([a.aggregate_id])
    if(kind==='invalid operation') m.operation_id='bad'
    if(kind==='same cards') {m.payload.primary_supplier_id=supplier;m.aggregate_id=supplier}
    if(kind==='duplicate invoice') m.payload.invoices.push(structuredClone(m.payload.invoices[0]))
    if(kind==='duplicate payment') {m.payload.invoices[0].payments.push(structuredClone(m.payload.invoices[0].payments[0]));m.payload.invoices[0].paid_amount=100}
    if(kind==='bad payment method') m.payload.invoices[0].payments[0].payment_method='unrecognized'
    const before=await mergeState(); await expect(mergeApply(m)).rejects.toBeDefined(); expect(await mergeState()).toEqual(before)
  })
  it('does not accept incomplete or mutable merge acknowledgement metadata', async () => {
    await state.db.query('INSERT INTO suppliers(id,tenant_id) VALUES($1,$2)',[second,tenant])
    await expect(state.db.query("INSERT INTO supplier_merge_receipts(tenant_id,duplicate_id,primary_id,result,merged_at,operation_id) VALUES($1,$2,$3,$4,$5,$6)",
      [tenant,supplier,second,JSON.stringify({id:second}),at,randomUUID()])).rejects.toMatchObject({code:'23514'})
    expect((await rows("SELECT has_table_privilege('service_role','supplier_merge_receipts','UPDATE') u,has_table_privilege('authenticated','supplier_merge_receipts','SELECT') r"))[0]).toEqual({u:false,r:false})
  })
})

describe('terminal supplier invoice copies', () => {
  it.each(['cancelled', 'deleted'] as const)('copies %s with exact historical contents and survives concurrent lost replies', async kind => {
    const a = operation(); await apply(a); const t = terminal(a, kind)
    await Promise.all([finish(t), finish(t)])
    const before = [await invoiceRows(), await lineRows(), await receipts()]
    t.applied_at = '2026-10-10T10:00:00Z'; await finish(t); await apply(a)
    expect([await invoiceRows(), await lineRows(), await receipts()]).toEqual(before)
    expect(await receipts()).toHaveLength(2)
    expect((await receipts())[1].lifecycle_hash).toMatch(/^[a-f0-9]{64}$/)
    expect((await invoiceRows())[0]).toMatchObject(kind === 'deleted'
      ? { status: 'draft', deleted_at: new Date(terminalAt) } : { status: 'cancelled', deleted_at: null })
    expect(await lineRows()).toHaveLength(1)
    expect(state.queries.join('\n')).not.toContain('UPDATE products')
    expect(await rows('SELECT * FROM cash_operations')).toEqual([])
  })
  it('acknowledges earlier creation/update/post after cancellation without re-posting', async () => {
    const a = operation(); await apply(a); const b = edit(a); await update(b); const c = post(a, b); await posting(c)
    const t = terminal(c, 'cancelled', true); await finish(t)
    const before = [await invoiceRows(), await lineRows(), await receipts()]
    await apply(a); await update(b); await posting(c); await finish(t)
    expect([await invoiceRows(), await lineRows(), await receipts()]).toEqual(before)
  })
  it('acknowledges earlier edit after draft deletion without restoring it', async () => {
    const a = operation(); await apply(a); const b = edit(a); await update(b)
    const t = terminal(b, 'deleted'); t.payload.previous_invoice.created_at = at
    await finish(t); await update(b); await apply(a)
    expect((await invoiceRows())[0].deleted_at).toEqual(new Date(terminalAt))
  })
  it.each(['cancelled', 'deleted'] as const)('rejects missing or foreign %s without a false success', async kind => {
    const a = operation(), t = terminal(a, kind)
    await expect(finish(t)).rejects.toMatchObject({ status: 409 })
    await apply(a); t.tenant_id = other
    await expect(finish(t)).rejects.toMatchObject({ status: 422 })
    expect(await receipts()).toHaveLength(1)
    expect((await invoiceRows())[0].status).toBe('draft')
  })
  it.each(['cancelled', 'deleted'] as const)('refuses paid %s, including a damaged zero header', async kind => {
    const a = operation(50); await apply(a); const t = terminal(a, kind)
    await expect(finish(t)).rejects.toMatchObject({ status: 409 })
    await state.db.exec('UPDATE supply_invoices SET paid_amount=0,payment_method=NULL')
    await expect(finish(t)).rejects.toMatchObject({ status: 409 })
    expect(await rows('SELECT * FROM supplier_payments')).toHaveLength(1)
    expect(await receipts()).toHaveLength(1)
  })
  it.each(['posted', 'cancelled'])('cannot delete a %s document', async status => {
    const a = operation(); await apply(a); const t = terminal(a, 'deleted')
    if (status === 'posted') { const p = post(a); await posting(p); t.sequence = 3; t.payload.previous_status = 'posted'; t.payload.posted_by = actor; t.payload.posted_at = postedAt }
    else { await finish(terminal(a)); t.sequence = 3 }
    await expect(finish(t)).rejects.toMatchObject({ status: 409 })
    expect((await invoiceRows())[0].deleted_at).toBeNull()
  })
  it.each(['snapshot', 'status', 'actor', 'posted date', 'partial snapshot', 'bad time', 'null time', 'aggregate', 'sequence', 'type'])
    ('refuses terminal %s mismatch', async field => {
      const a = operation(); await apply(a); const t = terminal(a)
      if (field === 'snapshot') t.payload.previous_invoice.notes = 'stale'
      if (field === 'status') t.payload.previous_status = 'posted'
      if (field === 'actor') t.payload.posted_by = actor
      if (field === 'posted date') t.payload.posted_at = at
      if (field === 'partial snapshot') delete t.payload.posted_by
      if (field === 'bad time') t.payload.created_at = 'bad'
      if (field === 'null time') t.payload.created_at = null
      if (field === 'aggregate') t.aggregate_id = randomUUID()
      if (field === 'sequence') t.sequence = 1
      if (field === 'type') t.operation_type = 'supplier_invoice.created'
      await expect(finish(t)).rejects.toBeDefined()
      expect((await invoiceRows())[0].status).toBe('draft'); expect(await receipts()).toHaveLength(1)
    })
  it.each(['time', 'snapshot', 'sequence', 'device', 'kind'])('rejects changed %s on terminal retry', async field => {
    const a = operation(); await apply(a); const t = terminal(a); await finish(t)
    if (field === 'time') t.payload.created_at = applied
    if (field === 'snapshot') t.payload.previous_invoice.notes = 'different'
    if (field === 'sequence') t.sequence++
    if (field === 'device') t.device_id = 'other'
    if (field === 'kind') t.operation_type = 'supplier_invoice.deleted'
    await expect(finish(t)).rejects.toMatchObject({ status: 409 })
    expect(await receipts()).toHaveLength(2)
  })
  it.each(['status', 'delete time', 'posted actor', 'posted time', 'missing lines', 'line quantity', 'line date', 'payment'])
    ('detects %s corruption even when an old operation is retried', async field => {
      const a = operation(); await apply(a); const t = terminal(a, 'deleted'); await finish(t)
      const sql: Record<string,string> = {
        status: "UPDATE supply_invoices SET status='posted'",
        'delete time': "UPDATE supply_invoices SET deleted_at='2026-10-10'",
        'posted actor': "UPDATE supply_invoices SET posted_by='" + actor + "'",
        'posted time': "UPDATE supply_invoices SET posted_at='2026-10-10'",
        'missing lines': 'DELETE FROM supply_invoice_items',
        'line quantity': 'UPDATE supply_invoice_items SET qty=3,total=300; UPDATE supply_invoices SET total=300',
        'line date': "UPDATE supply_invoice_items SET created_at='2026-10-10'",
        payment: "UPDATE supply_invoices SET paid_amount=1,payment_method='cash'",
      }
      await state.db.exec(sql[field])
      await expect(finish(t)).rejects.toMatchObject({ status: 409 })
      await expect(apply(a)).rejects.toMatchObject({ status: 409 })
    })
  it.each(['cancelled', 'deleted'] as const)('detects lost modern %s receipt instead of restoring old state', async kind => {
    const a = operation(); await apply(a); const t = terminal(a, kind); await finish(t)
    await state.db.query('DELETE FROM supplier_invoice_copy_receipts WHERE operation_id=$1', [t.operation_id])
    await expect(finish(t)).rejects.toMatchObject({ status: 409 })
    await expect(apply(a)).rejects.toMatchObject({ status: 409 })
  })
  it('blocks a new payment if a cancelled status was externally reverted', async () => {
    const a = operation(); await apply(a); await finish(terminal(a))
    await state.db.exec("UPDATE supply_invoices SET status='draft'")
    await expect(pay(paymentOperation(a))).rejects.toMatchObject({ status: 409 })
    expect(await rows('SELECT * FROM supplier_payments')).toHaveLength(0)
  })
  it.each(['cancelled', 'deleted'] as const)('accepts an ordered legacy ID-only %s once', async kind => {
    const a = operation(); await apply(a); const t = terminal(a, kind); t.payload = { id: a.aggregate_id }
    await finish(t); await finish(t)
    expect(await receipts()).toHaveLength(2)
  })
  it.each(['cancelled', 'deleted'] as const)('does not guess an acknowledgement for legacy already-%s data', async kind => {
    const a = operation(); await apply(a); const t = terminal(a, kind); t.payload = { id: a.aggregate_id }
    await state.db.exec('DELETE FROM supplier_invoice_copy_receipts')
    await state.db.exec(kind === 'cancelled' ? "UPDATE supply_invoices SET status='cancelled'" : "UPDATE supply_invoices SET deleted_at='2026-09-29'")
    await expect(finish(t)).rejects.toMatchObject({ status: 409 }); expect(await receipts()).toHaveLength(0)
  })
  it.each(['cancelled', 'deleted'] as const)('rolls back %s if the acknowledgement cannot be stored', async kind => {
    const a = operation(); await apply(a); const t = terminal(a, kind), before = await invoiceRows()
    state.fail = 'INSERT INTO supplier_invoice_copy_receipts'
    await expect(finish(t)).rejects.toThrow('injected storage failure')
    expect(await invoiceRows()).toEqual(before); expect(await receipts()).toHaveLength(1)
    state.fail = ''; await finish(t); expect(await receipts()).toHaveLength(2)
  })
  it('allows only the first of concurrent cancellation and deletion', async () => {
    const a = operation(); await apply(a)
    const result = await Promise.allSettled([finish(terminal(a)), finish(terminal(a, 'deleted'))])
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(await receipts()).toHaveLength(2)
  })
  it('requires lifecycle integrity for every terminal receipt at database level', async () => {
    const a = operation(); await apply(a)
    await expect(state.db.query("INSERT INTO supplier_invoice_copy_receipts(tenant_id,operation_id,invoice_id,operation_type,payload_hash,document_hash,device_id,source_sequence) SELECT tenant_id,$1,invoice_id,'supplier_invoice.deleted',payload_hash,document_hash,device_id,2 FROM supplier_invoice_copy_receipts", [randomUUID()]))
      .rejects.toMatchObject({ code: '23514' })
  })
})

describe('immutable supplier payment copies', () => {
  it('copies a closed-shift payment with original author/date without consuming current cash or stock', async () => {
    const a = operation(); await apply(a); const p = paymentOperation(a); await pay(p)
    expect(await rows('SELECT id,amount,created_by,created_at FROM supplier_payments')).toEqual([
      { id: p.payload.payment_id, amount: 75, created_by: actor, created_at: new Date(at) }])
    expect(await rows('SELECT id,amount,created_by FROM cash_operations')).toEqual([
      { id: p.payload.payment_id, amount: 75, created_by: actor }])
    expect((await rows('SELECT paid_amount,payment_method FROM supply_invoices'))[0]).toEqual({ paid_amount: 75, payment_method: 'cash' })
    expect(await rows('SELECT qty_on_hand FROM products')).toEqual([{ qty_on_hand: '0' }, { qty_on_hand: '0' }])
    expect(state.queries.join('\n')).not.toMatch(/UPDATE products|opening_cash|status='open'/)
  })
  it('serializes parallel retries and leaves the original timestamps unchanged', async () => {
    const a = operation(); await apply(a); const p = paymentOperation(a)
    await Promise.all([pay(p), pay(p)])
    const before = await rows('SELECT * FROM supply_invoices')
    p.applied_at = '2026-10-07T12:00:00Z'; await pay(p)
    expect(await rows('SELECT * FROM supply_invoices')).toEqual(before)
    expect(await rows('SELECT * FROM supplier_payments')).toHaveLength(1)
    expect(await rows('SELECT * FROM cash_operations')).toHaveLength(1)
  })
  it.each(['owner_funds', 'bank_account', 'business_card'])('does not touch cash for %s', async source => {
    const a = operation(); await apply(a); const p = paymentOperation(a)
    p.payload.fund_source = source; p.payload.shift_id = null
    p.payload.payment_method = source === 'owner_funds' ? 'cash' : 'card'
    await pay(p); await pay(p)
    expect(await rows('SELECT * FROM cash_operations')).toHaveLength(0)
  })
  it('accepts a null supplier without inventing one', async () => {
    const a = operation(); a.payload.supplier_id = null; await apply(a)
    const p = paymentOperation(a); p.payload.supplier_id = null; await pay(p)
    expect((await rows('SELECT supplier_id FROM supplier_payments'))[0].supplier_id).toBeNull()
  })
  it('keeps prior payment valid after later payment, edit, posting and creation replay', async () => {
    const a = operation(20); await apply(a); const p = paymentOperation(a); await pay(p)
    const b = edit(a); b.sequence = 3; await update(b)
    const c = post(a, b); c.sequence = 4; await posting(c)
    const q = paymentOperation(a, 105); q.sequence = 5; q.payload.fund_source = 'owner_funds'; q.payload.shift_id = null
    await pay(q); await pay(p); await apply(a); await update(b); await posting(c)
    expect((await rows('SELECT paid_amount FROM supply_invoices'))[0].paid_amount).toBe(200)
    expect(await rows('SELECT * FROM supplier_payments')).toHaveLength(3)
    expect(await rows('SELECT * FROM cash_operations')).toHaveLength(2)
  })
  it('prevents two different simultaneous payments from overpaying', async () => {
    const a = operation(); await apply(a)
    const results = await Promise.allSettled([pay(paymentOperation(a, 150)), pay(paymentOperation(a, 150))])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((await rows('SELECT paid_amount FROM supply_invoices'))[0].paid_amount).toBe(150)
    expect(await rows('SELECT * FROM supplier_payments')).toHaveLength(1)
  })
  it('allows exact remaining kopecks but refuses one kopeck more', async () => {
    const a = operation(199); await apply(a)
    await expect(pay(paymentOperation(a, 2))).rejects.toMatchObject({ status: 409 })
    const p = paymentOperation(a, 1); await pay(p); await pay(p)
    expect((await rows('SELECT paid_amount FROM supply_invoices'))[0].paid_amount).toBe(200)
  })
  it.each(['amount', 'method', 'source', 'shift', 'note', 'actor', 'date', 'supplier', 'invoice'])('rejects changed %s on retry', async kind => {
    const a = operation(); await apply(a); const p = paymentOperation(a); await pay(p)
    const before = await rows('SELECT * FROM supplier_payments')
    if (kind === 'amount') p.payload.amount++
    if (kind === 'method') { p.payload.payment_method = 'card'; p.payload.fund_source = 'business_card' }
    if (kind === 'source') p.payload.fund_source = 'owner_funds'
    if (kind === 'shift') p.payload.shift_id = randomUUID()
    if (kind === 'note') p.payload.note = 'Інша примітка'
    if (kind === 'actor') p.payload.user_id = uploader
    if (kind === 'date') p.payload.created_at = applied
    if (kind === 'supplier') p.payload.supplier_id = null
    if (kind === 'invoice') { const b = operation(); await apply(b); p.aggregate_id = b.aggregate_id; p.payload.id = b.aggregate_id }
    await expect(pay(p)).rejects.toMatchObject({ status: 409 })
    expect(await rows('SELECT * FROM supplier_payments')).toEqual(before)
  })
  it.each(['zero', 'negative', 'fraction', 'overflow', 'string', 'missing actor', 'missing supplier', 'missing payment',
    'bad date', 'bad method', 'bad source', 'cash without shift', 'cash with card', 'foreign envelope', 'bad sequence', 'wrong aggregate'])
    ('refuses invalid %s before recording money', async kind => {
      const a = operation(); await apply(a); const p = paymentOperation(a)
      if (kind === 'zero') p.payload.amount = 0
      if (kind === 'negative') p.payload.amount = -1
      if (kind === 'fraction') p.payload.amount = 1.2
      if (kind === 'overflow') p.payload.amount = 2147483648
      if (kind === 'string') p.payload.amount = '75'
      if (kind === 'missing actor') delete p.payload.user_id
      if (kind === 'missing supplier') delete p.payload.supplier_id
      if (kind === 'missing payment') delete p.payload.payment_id
      if (kind === 'bad date') p.payload.created_at = 'unknown'
      if (kind === 'bad method') p.payload.payment_method = 'debt'
      if (kind === 'bad source') p.payload.fund_source = 'unknown'
      if (kind === 'cash without shift') p.payload.shift_id = null
      if (kind === 'cash with card') p.payload.payment_method = 'card'
      if (kind === 'foreign envelope') p.tenant_id = other
      if (kind === 'bad sequence') p.sequence = 0
      if (kind === 'wrong aggregate') p.payload.id = randomUUID()
      await expect(pay(p)).rejects.toMatchObject({ status: 422 })
      expect(await rows('SELECT * FROM supplier_payments')).toHaveLength(0)
      expect((await rows('SELECT paid_amount FROM supply_invoices'))[0].paid_amount).toBe(0)
    })
  it.each(['actor', 'shift', 'supplier'])('refuses a foreign %s reference', async kind => {
    const a = operation(); await apply(a)
    if (kind === 'actor') await state.db.query("UPDATE auth.users SET raw_app_meta_data=jsonb_build_object('tenant_id',$1::text)", [other])
    else await state.db.query('UPDATE ' + (kind === 'shift' ? 'shifts' : 'suppliers') + ' SET tenant_id=$1', [other])
    await expect(pay(paymentOperation(a))).rejects.toMatchObject({ status: 409 })
    expect(await rows('SELECT * FROM supplier_payments')).toHaveLength(0)
  })
  it.each(['cash missing', 'cash amount', 'cash note', 'cash actor', 'cash date', 'cash tenant', 'cash shift',
    'cash type', 'cash source', 'cash deleted', 'cash sale', 'cash employee', 'cash work date', 'tombstone',
    'payment missing', 'payment tenant', 'payment deleted', 'header paid', 'header notes'])
    ('rejects corrupt %s without repairing it from stale data', async kind => {
      const a = operation(); await apply(a); const p = paymentOperation(a); await pay(p)
      const statements: Record<string, [string, any[]]> = {
        'cash missing': ['DELETE FROM cash_operations', []], 'cash amount': ['UPDATE cash_operations SET amount=74', []],
        'cash note': ["UPDATE cash_operations SET note='wrong'", []], 'cash actor': ['UPDATE cash_operations SET created_by=$1', [uploader]],
        'cash date': ['UPDATE cash_operations SET created_at=$1', [applied]], 'cash tenant': ['UPDATE cash_operations SET tenant_id=$1', [other]],
        'cash shift': ['UPDATE cash_operations SET shift_id=$1', [randomUUID()]], 'cash type': ["UPDATE cash_operations SET type='in'", []],
        'cash source': ["UPDATE cash_operations SET source='owner_funds'", []], 'cash deleted': ['UPDATE cash_operations SET deleted_at=$1', [at]],
        'cash sale': ['UPDATE cash_operations SET sale_id=$1', [randomUUID()]], 'cash employee': ['UPDATE cash_operations SET employee_id=$1', [randomUUID()]],
        'cash work date': ["UPDATE cash_operations SET work_date='2026-09-28'", []],
        tombstone: ["INSERT INTO sync_deletions VALUES($1,'cash_operation',$2)", [tenant, p.payload.payment_id]],
        'payment missing': ['DELETE FROM supplier_payments', []], 'payment tenant': ['UPDATE supplier_payments SET tenant_id=$1', [other]],
        'payment deleted': ['UPDATE supplier_payments SET deleted_at=$1', [at]], 'header paid': ['UPDATE supply_invoices SET paid_amount=76', []],
        'header notes': ["UPDATE supply_invoices SET notes='Підміна'", []],
      }
      const [sql, args] = statements[kind]; await state.db.query(sql, args)
      const before = await rows('SELECT * FROM cash_operations')
      await expect(pay(p)).rejects.toMatchObject({ status: 409 })
      expect(await rows('SELECT * FROM cash_operations')).toEqual(before)
    })
  it('refuses an orphan cash collision instead of silently skipping it', async () => {
    const a = operation(); await apply(a); const p = paymentOperation(a)
    await state.db.query("INSERT INTO cash_operations(id,tenant_id,amount) VALUES($1,$2,75)", [p.payload.payment_id, other])
    await expect(pay(p)).rejects.toMatchObject({ status: 409 })
    expect(await rows('SELECT * FROM supplier_payments')).toHaveLength(0)
  })
  it('refuses a payment ID owned by another tenant', async () => {
    const a = operation(); await apply(a); const p = paymentOperation(a)
    await state.db.query('INSERT INTO supplier_payments(id,tenant_id,amount,created_by) VALUES($1,$2,75,$3)', [p.payload.payment_id, other, actor])
    await expect(pay(p)).rejects.toMatchObject({ status: 409 })
    expect((await rows('SELECT paid_amount FROM supply_invoices'))[0].paid_amount).toBe(0)
  })
  it('does not acknowledge cash attached to a noncash payment', async () => {
    const a = operation(); await apply(a); const p = paymentOperation(a); p.payload.fund_source = 'owner_funds'
    await pay(p)
    await state.db.query('INSERT INTO cash_operations(id,tenant_id,amount) VALUES($1,$2,75)', [p.payload.payment_id, tenant])
    await expect(pay(p)).rejects.toMatchObject({ status: 409 })
  })
  it.each(['cancelled', 'deleted'])('does not pay a %s invoice', async status => {
    const a = operation(); await apply(a)
    await state.db.exec(status === 'cancelled' ? "UPDATE supply_invoices SET status='cancelled'" : "UPDATE supply_invoices SET deleted_at=now()")
    await expect(pay(paymentOperation(a))).rejects.toMatchObject({ status: 409 })
  })
  it('does not reuse a document operation ID for a payment', async () => {
    const a = operation(); await apply(a); const p = paymentOperation(a); p.operation_id = a.operation_id
    await expect(pay(p)).rejects.toMatchObject({ status: 409 })
  })
  it.each(['INSERT INTO supplier_payments', 'UPDATE supply_invoices', 'INSERT INTO cash_operations'])
    ('rolls back all effects after failure at %s and safely retries', async failing => {
      const a = operation(); await apply(a); const p = paymentOperation(a)
      state.fail = failing; await expect(pay(p)).rejects.toThrow('injected storage failure')
      expect(await rows('SELECT * FROM supplier_payments')).toHaveLength(0)
      expect(await rows('SELECT * FROM cash_operations')).toHaveLength(0)
      expect((await rows('SELECT paid_amount FROM supply_invoices'))[0].paid_amount).toBe(0)
      state.fail = ''; await pay(p); await pay(p)
      expect(await rows('SELECT * FROM supplier_payments')).toHaveLength(1)
    })
})

describe('complete supplier invoice creation copies', () => {
  it('copies every exact historical row without adding stock or using current prices', async () => {
    const op = operation(); await apply(op)
    expect(await rows('SELECT id,qty,purchase_price,total,created_at FROM supply_invoice_items')).toEqual([
      { id: op.payload.items[0].id, qty: '2.000', purchase_price: 100, total: 200, created_at: new Date(at) },
    ])
    expect(await rows('SELECT qty_on_hand FROM products')).toEqual([{ qty_on_hand: '0' }, { qty_on_hand: '0' }])
  })
  it('does not acknowledge a header whose lines are missing', async () => {
    const op = operation(); await apply(op)
    await state.db.exec('DELETE FROM supply_invoice_items')
    await expect(apply(op)).rejects.toMatchObject({ code: 'SYNC_INVOICE_COPY_CONFLICT', status: 409 })
    expect(await rows('SELECT * FROM supply_invoice_items')).toEqual([])
  })
  it('accepts an exact replay without changing timestamps or payments', async () => {
    const op = operation(100); await apply(op)
    const before = await rows('SELECT * FROM supply_invoices')
    op.applied_at = '2026-10-07T12:00:00Z'; await apply(op)
    expect(await rows('SELECT * FROM supply_invoices')).toEqual(before)
    expect(await rows('SELECT * FROM supplier_payments')).toHaveLength(1)
    expect(await rows('SELECT * FROM cash_operations')).toHaveLength(1)
  })
  it.each(['quantity', 'price', 'line id', 'line date', 'product', 'supplier', 'number', 'notes', 'date'])('rejects changed %s without overwriting', async kind => {
    const op = operation(); await apply(op)
    const before = await rows('SELECT * FROM supply_invoice_items')
    const p = op.payload, line = p.items[0]
    if (kind === 'quantity') { line.qty = 1; line.purchase_price = 200 }
    if (kind === 'price') { line.qty = 4; line.purchase_price = 50 }
    if (kind === 'line id') line.id = randomUUID()
    if (kind === 'line date') line.created_at = applied
    if (kind === 'product') line.product_id = second
    if (kind === 'supplier') p.supplier_id = null
    if (kind === 'number') p.invoice_number = 'OTHER'
    if (kind === 'notes') p.notes = 'OTHER'
    if (kind === 'date') p.created_at = applied
    await expect(apply(op)).rejects.toMatchObject({ status: 409 })
    expect(await rows('SELECT * FROM supply_invoice_items')).toEqual(before)
  })
  it.each(['header tenant', 'line tenant', 'deleted header', 'deleted line', 'extra line', 'paid header', 'payment method'])('rejects corrupt %s', async kind => {
    const op = operation(); await apply(op)
    if (kind === 'header tenant') { await state.db.exec('DELETE FROM supplier_invoice_copy_receipts'); await state.db.query('UPDATE supply_invoices SET tenant_id=$1', [other]) }
    if (kind === 'line tenant') await state.db.query('UPDATE supply_invoice_items SET tenant_id=$1', [other])
    if (kind === 'deleted header') await state.db.query('UPDATE supply_invoices SET deleted_at=$1', [applied])
    if (kind === 'deleted line') await state.db.query('UPDATE supply_invoice_items SET deleted_at=$1', [applied])
    if (kind === 'paid header') await state.db.exec('UPDATE supply_invoices SET paid_amount=10')
    if (kind === 'payment method') await state.db.exec("UPDATE supply_invoices SET payment_method='cash'")
    if (kind === 'extra line') await state.db.query('INSERT INTO supply_invoice_items SELECT $1,tenant_id,invoice_id,product_id,qty,purchase_price,total,created_at,deleted_at FROM supply_invoice_items', [randomUUID()])
    await expect(apply(op)).rejects.toMatchObject({ status: 409 })
  })
  it.each(['product', 'supplier', 'shift', 'payer'])('rejects foreign %s before inserting anything', async kind => {
    const op = operation(100)
    if (kind === 'payer') await state.db.query("UPDATE auth.users SET raw_app_meta_data=jsonb_build_object('tenant_id',$1::text)", [other])
    else await state.db.query('UPDATE ' + ({ product: 'products', supplier: 'suppliers', shift: 'shifts' } as any)[kind] + ' SET tenant_id=$1', [other])
    await expect(apply(op)).rejects.toThrow()
    expect(await rows('SELECT * FROM supply_invoices')).toEqual([])
  })
  it('accepts archived products and suppliers without restoring their cards', async () => {
    await state.db.query('UPDATE products SET deleted_at=$1', [at])
    await state.db.query('UPDATE suppliers SET deleted_at=$1', [at])
    await apply(operation())
    expect((await rows('SELECT deleted_at FROM suppliers'))[0].deleted_at).toEqual(new Date(at))
  })
  it('never silently steals or skips a row ID already used by another invoice', async () => {
    const first = operation(); await apply(first)
    const op = operation(); op.payload.items[0].id = first.payload.items[0].id
    await expect(apply(op)).rejects.toMatchObject({ status: 409 })
    expect(await rows('SELECT * FROM supply_invoices')).toHaveLength(1)
  })
  it.each(['line', 'payment', 'cash'])('rolls back the whole document after %s insertion failure', async kind => {
    state.fail = ({ line: 'INSERT INTO supply_invoice_items', payment: 'INSERT INTO supplier_payments', cash: 'INSERT INTO cash_operations' } as any)[kind]
    await expect(apply(operation(100))).rejects.toThrow('injected storage failure')
    for (const table of ['supply_invoices', 'supply_invoice_items', 'supplier_payments', 'cash_operations']) expect(await rows('SELECT * FROM ' + table)).toEqual([])
  })
  it('serializes simultaneous retries', async () => {
    const op = operation(100); await Promise.all([apply(op), apply(op)])
    expect(await rows('SELECT * FROM supply_invoice_items')).toHaveLength(1)
    expect(await rows('SELECT * FROM cash_operations')).toHaveLength(1)
  })
  it('keeps repeated product lines with distinct IDs and prices', async () => {
    const op = operation()
    op.payload.items.push({ ...op.payload.items[0], id: randomUUID(), qty: .333, purchase_price: 50, total: 17 })
    op.payload.total = 217
    await apply(op); await apply(op)
    expect(await rows('SELECT * FROM supply_invoice_items')).toHaveLength(2)
  })
  it('copies historical cash payment from a closed empty shift using its real payer', async () => {
    const op = operation(100); await apply(op)
    expect(await rows('SELECT created_by,created_at FROM supplier_payments')).toEqual([{ created_by: actor, created_at: new Date(at) }])
    expect(await rows('SELECT id,amount,created_by FROM cash_operations')).toEqual([{ id: op.payload.payment_id, amount: 100, created_by: actor }])
    expect(await rows('SELECT status,opening_cash FROM shifts')).toEqual([{ status: 'closed', opening_cash: 0 }])
    expect(state.queries.join('\n')).not.toContain('UPDATE products')
  })
  it.each(['owner_funds', 'bank_account', 'business_card'])('does not consume cash for %s', async source => {
    const op = operation(100); op.payload.fund_source = source; op.payload.shift_id = null
    op.payload.payment_method = source === 'owner_funds' ? 'cash' : 'transfer'
    await apply(op); await apply(op)
    expect(await rows('SELECT * FROM cash_operations')).toEqual([])
  })
  it.each(['missing payment', 'payment amount', 'payment actor', 'payment date', 'payment source', 'cash amount', 'cash actor', 'cash deleted', 'cash missing', 'cash sale'])('rejects mismatched %s on retry', async kind => {
    const op = operation(100); await apply(op)
    const updates: Record<string, string> = {
      'missing payment': 'DELETE FROM supplier_payments', 'payment amount': 'UPDATE supplier_payments SET amount=99',
      'payment actor': "UPDATE supplier_payments SET created_by='" + uploader + "'",
      'payment date': "UPDATE supplier_payments SET created_at='" + applied + "'",
      'payment source': "UPDATE supplier_payments SET fund_source='owner_funds'",
      'cash amount': 'UPDATE cash_operations SET amount=99',
      'cash actor': "UPDATE cash_operations SET created_by='" + uploader + "'",
      'cash deleted': "UPDATE cash_operations SET deleted_at='" + applied + "'",
      'cash missing': 'DELETE FROM cash_operations', 'cash sale': "UPDATE cash_operations SET sale_id='" + randomUUID() + "'",
    }
    await state.db.exec(updates[kind])
    await expect(apply(op)).rejects.toMatchObject({ status: 409 })
  })
  it('does not overwrite a foreign payment or cash ID', async () => {
    const first = operation(100); await apply(first)
    const op = operation(100); op.payload.payment_id = first.payload.payment_id
    await expect(apply(op)).rejects.toMatchObject({ status: 409 })
    expect(await rows('SELECT * FROM supply_invoices')).toHaveLength(1)
  })
  it('preserves a later valid payment and posted status when acknowledging creation', async () => {
    const op = operation(100); await apply(op)
    const payment = paymentOperation(op, 100)
    payment.payload.payment_method = 'transfer'; payment.payload.fund_source = 'bank_account'; payment.payload.shift_id = null
    await pay(payment)
    const posted = post(op); posted.sequence = 3; await posting(posted)
    await apply(op)
    expect((await rows('SELECT status,paid_amount,payment_method FROM supply_invoices'))[0]).toEqual({ status: 'posted', paid_amount: 200, payment_method: 'transfer' })
  })
  it.each([
    ['null paid', (p: any) => { p.paid_amount = null }],
    ['overpayment', (p: any) => { p.paid_amount = 201 }],
    ['missing payer', (p: any) => { delete p.user_id }],
    ['null payer', (p: any) => { p.user_id = null }],
    ['missing payment ID', (p: any) => { p.payment_id = null }],
    ['bad fund source', (p: any) => { p.fund_source = 'unknown' }],
    ['noncash cashbox', (p: any) => { p.payment_method = 'card' }],
    ['cashbox without shift', (p: any) => { p.shift_id = null }],
    ['missing line ID', (p: any) => { delete p.items[0].id }],
    ['missing line total', (p: any) => { delete p.items[0].total }],
    ['wrong line total', (p: any) => { p.items[0].total = 100 }],
    ['wrong header total', (p: any) => { p.total = 100 }],
    ['fractional price', (p: any) => { p.items[0].purchase_price = 100.1 }],
    ['null price', (p: any) => { p.items[0].purchase_price = null }],
    ['zero qty', (p: any) => { p.items[0].qty = 0 }],
    ['overprecise qty', (p: any) => { p.items[0].qty = .0001 }],
    ['string qty', (p: any) => { p.items[0].qty = '2' }],
    ['empty invoice', (p: any) => { p.items = [] }],
    ['duplicate row ID', (p: any) => { p.items.push({ ...p.items[0] }); p.total = 400 }],
    ['null date', (p: any) => { p.created_at = null }],
    ['null line date', (p: any) => { p.items[0].created_at = null }],
    ['wrong ID', (p: any) => { p.id = randomUUID() }],
    ['overflow', (p: any) => { p.items[0].purchase_price = 2147483647; p.items[0].total = 2147483647; p.total = 2147483647 }],
  ])('rejects %s before any partial copy', async (_label, mutate) => {
    const op = operation(100); (mutate as (p: any) => void)(op.payload)
    await expect(apply(op)).rejects.toMatchObject({ status: 422 })
    expect(await rows('SELECT * FROM supply_invoices')).toEqual([])
  })
  it('supports legacy complete lines without repeated line dates or header total', async () => {
    const op = operation(); delete op.payload.items[0].created_at; delete op.payload.total
    await apply(op)
    expect((await rows('SELECT created_at FROM supply_invoice_items'))[0].created_at).toEqual(new Date(at))
  })
  it('does not require the current stock mirror flag to avoid new stock/cash validation', async () => {
    const op = operation(100); delete op.balance_mirrored; await apply(op)
    expect(await rows('SELECT qty_on_hand FROM products')).toEqual([{ qty_on_hand: '0' }, { qty_on_hand: '0' }])
  })
  it('accepts zero purchase cost and exact thousandths', async () => {
    const op = operation(); Object.assign(op.payload.items[0], { qty: .001, purchase_price: 0, total: 0 }); op.payload.total = 0
    await apply(op); await apply(op)
  })
})

function snapshot(op: any) {
  const p = op.payload
  return { supplier_id: p.supplier_id, invoice_number: p.invoice_number, notes: p.notes,
    total: p.total, created_at: p.created_at, items: structuredClone(p.items) }
}
const editedAt = '2026-09-28T13:00:00.000Z', postedAt = '2026-09-28T14:00:00.000Z'
function edit(op: any): any {
  return { ...op, sequence: op.sequence + 1, operation_id: randomUUID(), operation_type: 'supplier_invoice.updated',
    payload: { id: op.aggregate_id, created_at: editedAt, supplier_id: supplier, invoice_number: 'CORRECTED', notes: '98 шт',
      total: 9800, items: [{ id: randomUUID(), product_id: product, qty: 98, purchase_price: 100, total: 9800, created_at: editedAt }],
      previous_invoice: snapshot(op) } }
}
function post(created: any, updated?: any): any {
  const doc = updated ? { ...snapshot(created), ...updated.payload, created_at: created.payload.created_at } : snapshot(created)
  return { ...created, sequence: (updated?.sequence ?? created.sequence) + 1, operation_id: randomUUID(), operation_type: 'supplier_invoice.posted',
    payload: { id: created.aggregate_id, created_at: postedAt, user_id: actor,
      items: doc.items.map((i: any) => ({ product_id: i.product_id, qty: i.qty, purchase_price: i.purchase_price })),
      invoice_snapshot: { supplier_id: doc.supplier_id, invoice_number: doc.invoice_number, notes: doc.notes,
        total: doc.total, created_at: doc.created_at, items: doc.items } } }
}
const update = (op: any) => applySupplierInvoiceUpdated(tenant, op)
const posting = (op: any) => applySupplierInvoicePosted(tenant, uploader, op)
const invoiceRows = () => rows('SELECT * FROM supply_invoices ORDER BY id')
const lineRows = () => rows('SELECT * FROM supply_invoice_items ORDER BY id')
const receipts = () => rows('SELECT * FROM supplier_invoice_copy_receipts ORDER BY receipt_no')

describe('invoice creation -> editing -> posting with lost acknowledgement', () => {
  it('replays the entire chain without replacing 98 by the original quantity or paying again', async () => {
    const a = operation(100), b = edit(a), c = post(a, b)
    await apply(a); await update(b); await posting(c)
    const before = [await invoiceRows(), await lineRows(), await receipts(), await rows('SELECT * FROM cash_operations')]
    for (const op of [a, b, c]) { op.applied_at = '2026-10-09T10:00:00Z'; op.created_at = op.applied_at }
    await apply(a); await update(b); await posting(c)
    expect([await invoiceRows(), await lineRows(), await receipts(), await rows('SELECT * FROM cash_operations')]).toEqual(before)
    expect((await lineRows())[0].qty).toBe('98.000')
    expect((await invoiceRows())[0]).toMatchObject({ status: 'posted', posted_by: actor, posted_at: new Date(postedAt), total: 9800, paid_amount: 100 })
    expect(await rows('SELECT qty_on_hand FROM products')).toEqual([{ qty_on_hand: '0' }, { qty_on_hand: '0' }])
  })
  it('accepts an old update after a newer update without undoing it', async () => {
    const a = operation(); await apply(a)
    const b = edit(a); await update(b)
    const c = structuredClone(b); c.operation_id = randomUUID(); c.sequence += 1
    c.payload.previous_invoice = { ...snapshot(a), ...b.payload, created_at: at }
    c.payload.notes = 'Третя версія'; await update(c)
    await update(b); await apply(a)
    expect((await invoiceRows())[0].notes).toBe('Третя версія')
    expect(await receipts()).toHaveLength(3)
  })
  it('rejects a reordered or stale new edit using its original document snapshot', async () => {
    const a = operation(); await apply(a)
    const b = edit(a), c = edit(a); await update(b)
    await expect(update(c)).rejects.toMatchObject({ status: 409 })
    expect(await receipts()).toHaveLength(2)
  })
  it('retains a no-op header edit and historical line dates', async () => {
    const a = operation(); await apply(a)
    const b = { ...edit(a), payload: { id: a.aggregate_id, created_at: editedAt, notes: 'Header only', previous_invoice: snapshot(a), total: 200 } }
    await update(b); await update(b); await apply(a)
    expect((await lineRows())[0].created_at).toEqual(new Date(at))
    expect((await invoiceRows())[0].notes).toBe('Header only')
  })
  it('uses the original update time for legacy lines without per-line dates', async () => {
    const a = operation(); await apply(a)
    const b = edit(a); delete b.payload.previous_invoice; delete b.payload.items[0].created_at
    await update(b); await update(b)
    expect((await lineRows())[0].created_at).toEqual(new Date(editedAt))
  })
  it('verifies repeated product lines as a multiset, not a single product row', async () => {
    const a = operation(); a.payload.items.push({ ...a.payload.items[0], id: randomUUID() }); a.payload.total = 400
    await apply(a)
    const c = post(a); delete c.payload.invoice_snapshot
    c.payload.items.pop()
    await expect(posting(c)).rejects.toMatchObject({ status: 409 })
    c.payload.items.push({ ...c.payload.items[0] }); await posting(c)
    expect((await invoiceRows())[0].status).toBe('posted')
  })
  it.each(['created', 'updated', 'posted'])('rejects reused %s operation ID with different data', async kind => {
    const a = operation(), b = edit(a), c = post(a, b)
    await apply(a); await update(b); await posting(c)
    const op = { created: a, updated: b, posted: c }[kind]!
    if (kind === 'posted') op.payload.created_at = editedAt
    else op.payload.notes = 'Підмінено'
    await expect(({ created: apply, updated: update, posted: posting } as any)[kind](op)).rejects.toMatchObject({ status: 409 })
    expect(await receipts()).toHaveLength(3)
  })
  it('rejects an operation ID reused for another invoice', async () => {
    const a = operation(); await apply(a)
    const b = operation(); b.operation_id = a.operation_id
    await expect(apply(b)).rejects.toMatchObject({ status: 409 })
    expect(await invoiceRows()).toHaveLength(1)
  })
  it.each(['missing line', 'coherent quantity', 'header notes', 'header date', 'line date', 'line tenant'])('does not hide %s damage behind a receipt', async kind => {
    const a = operation(), b = edit(a), c = post(a, b)
    await apply(a); await update(b); await posting(c)
    if (kind === 'missing line') await state.db.exec('DELETE FROM supply_invoice_items')
    if (kind === 'coherent quantity') await state.db.exec('UPDATE supply_invoice_items SET qty=97,total=9700; UPDATE supply_invoices SET total=9700')
    if (kind === 'header notes') await state.db.exec("UPDATE supply_invoices SET notes='changed'")
    if (kind === 'header date') await state.db.exec("UPDATE supply_invoices SET created_at='2026-10-01'")
    if (kind === 'line date') await state.db.exec("UPDATE supply_invoice_items SET created_at='2026-10-01'")
    if (kind === 'line tenant') await state.db.query('UPDATE supply_invoice_items SET tenant_id=$1', [other])
    for (const [fn, op] of [[apply, a], [update, b], [posting, c]] as const)
      await expect(fn(op)).rejects.toMatchObject({ status: 409 })
  })
  it.each(['UPDATE supply_invoices SET supplier_id', 'INSERT INTO supply_invoice_items', 'INSERT INTO supplier_invoice_copy_receipts'])('rolls back an edit when %s fails', async sql => {
    const a = operation(); await apply(a)
    const before = [await invoiceRows(), await lineRows(), await receipts()]
    state.fail = sql; await expect(update(edit(a))).rejects.toThrow('injected storage failure'); state.fail = ''
    expect([await invoiceRows(), await lineRows(), await receipts()]).toEqual(before)
  })
  it('rolls back creation and initial payment if saving the acknowledgement fails', async () => {
    state.fail = 'INSERT INTO supplier_invoice_copy_receipts'
    await expect(apply(operation(100))).rejects.toThrow('injected storage failure')
    expect(await invoiceRows()).toEqual([]); expect(await receipts()).toEqual([])
    expect(await rows('SELECT * FROM supplier_payments')).toEqual([])
    expect(await rows('SELECT * FROM cash_operations')).toEqual([])
  })
  it('rolls back posting if saving the acknowledgement fails', async () => {
    const a = operation(); await apply(a)
    const before = await invoiceRows()
    state.fail = 'INSERT INTO supplier_invoice_copy_receipts'; await expect(posting(post(a))).rejects.toThrow(); state.fail = ''
    expect(await invoiceRows()).toEqual(before); expect(await receipts()).toHaveLength(1)
  })
  it('serializes simultaneous edits and simultaneous posting retries', async () => {
    const a = operation(); await apply(a)
    const b = edit(a); await Promise.all([update(b), update(b)])
    const c = post(a, b); await Promise.all([posting(c), posting(c)])
    expect(await receipts()).toHaveLength(3); expect(await lineRows()).toHaveLength(1)
  })
  it('supports complete legacy copies by verifying them before adding a receipt', async () => {
    const a = operation(); await apply(a); await state.db.exec('DELETE FROM supplier_invoice_copy_receipts')
    await apply(a); expect(await receipts()).toHaveLength(1)
  })
  it('does not invent an old acknowledgement for a legacy document already edited', async () => {
    const a = operation(); await apply(a); await update(edit(a)); await state.db.exec('DELETE FROM supplier_invoice_copy_receipts')
    await expect(apply(a)).rejects.toMatchObject({ status: 409 })
    expect(await receipts()).toEqual([])
  })
  it('accepts a legacy exact posted document but refuses wrong actor/date', async () => {
    const a = operation(); await apply(a); const c = post(a); delete c.payload.invoice_snapshot
    await posting(c); await state.db.exec("DELETE FROM supplier_invoice_copy_receipts WHERE operation_type='supplier_invoice.posted'")
    await state.db.exec('UPDATE supplier_invoice_copy_receipts SET lifecycle_hash=NULL') // Simulate receipts created before lifecycle hashes.
    await posting(c); expect(await receipts()).toHaveLength(2)
    await state.db.query('UPDATE supply_invoices SET posted_by=$1', [uploader])
    await expect(posting(c)).rejects.toMatchObject({ status: 409 })
  })
  it('does not call stock RPCs even without the transport mirror flag', async () => {
    const a = operation(); await apply(a); const c = post(a); delete c.balance_mirrored
    await posting(c); await posting(c)
    expect(state.queries.join('\n')).not.toContain('UPDATE products')
  })
  it('does not resurrect a cancelled document by repeating creation or update', async () => {
    const a = operation(), b = edit(a), c = post(a, b); await apply(a); await update(b); await posting(c)
    await finish(terminal(c, 'cancelled', true))
    await apply(a); await update(b); await posting(c)
    expect((await invoiceRows())[0].status).toBe('cancelled')
  })
  it.each(['unpaid total', 'paid supplier'])('rejects editing %s inconsistently with payment', async kind => {
    const a = operation(100); await apply(a); const b = edit(a)
    if (kind === 'unpaid total') { b.payload.items[0].qty = .5; b.payload.items[0].total = 50; b.payload.total = 50 }
    else b.payload.supplier_id = null
    await expect(update(b)).rejects.toMatchObject({ status: 409 })
    expect((await invoiceRows())[0].total).toBe(200)
  })
  it('allows an unpaid supplier change and acknowledges the old creation without reverting it', async () => {
    const a = operation(); await apply(a); const b = edit(a); b.payload.supplier_id = null
    await update(b); await apply(a)
    expect((await invoiceRows())[0].supplier_id).toBeNull()
  })
  it.each(['qty', 'price', 'line total', 'header total', 'null date', 'empty', 'duplicate row', 'missing ID'])('rejects invalid update %s', async kind => {
    const a = operation(); await apply(a); const b = edit(a), p = b.payload
    if (kind === 'qty') p.items[0].qty = -1
    if (kind === 'price') p.items[0].purchase_price = .5
    if (kind === 'line total') p.items[0].total = 1
    if (kind === 'header total') p.total = 1
    if (kind === 'null date') p.created_at = null
    if (kind === 'empty') p.items = []
    if (kind === 'duplicate row') { p.items.push({ ...p.items[0] }); p.total *= 2 }
    if (kind === 'missing ID') delete p.items[0].id
    await expect(update(b)).rejects.toMatchObject({ status: 422 })
    expect(await receipts()).toHaveLength(1)
  })
  it.each(['missing actor', 'foreign actor', 'wrong quantity', 'wrong header', 'wrong date', 'wrong tenant'])('rejects posting with %s', async kind => {
    const a = operation(); await apply(a); const c = post(a)
    if (kind === 'missing actor') delete c.payload.user_id
    if (kind === 'foreign actor') c.payload.user_id = uploader
    if (kind === 'wrong quantity') c.payload.items[0].qty = 1
    if (kind === 'wrong header') c.payload.invoice_snapshot.notes = 'Wrong'
    if (kind === 'wrong date') c.payload.created_at = null
    if (kind === 'wrong tenant') c.tenant_id = other
    await expect(posting(c)).rejects.toThrow()
    expect((await invoiceRows())[0].status).toBe('draft')
  })
  it('rejects a row ID stolen from another invoice on update', async () => {
    const a = operation(), secondInvoice = operation(); await apply(a); await apply(secondInvoice)
    const b = edit(a); b.payload.items[0].id = secondInvoice.payload.items[0].id
    await expect(update(b)).rejects.toMatchObject({ status: 409 })
    expect(await lineRows()).toHaveLength(2)
  })


  it.each(['product', 'supplier'])('refuses foreign %s references in an edit', async kind => {
    const a = operation(); await apply(a); const b = edit(a)
    if (kind === 'product') {
      await state.db.query('INSERT INTO products VALUES($1,$2,100,0,NULL)', [randomUUID(), other])
      b.payload.items[0].product_id = (await rows('SELECT id FROM products WHERE tenant_id=$1', [other]))[0].id
    } else {
      const foreignSupplier = randomUUID()
      await state.db.query('INSERT INTO suppliers VALUES($1,$2,NULL)', [foreignSupplier, other])
      b.payload.supplier_id = foreignSupplier
    }
    await expect(update(b)).rejects.toMatchObject({ status: 409 })
    expect((await invoiceRows())[0].total).toBe(200)
  })
  it('detects lost newest receipt instead of treating the older creation as current', async () => {
    const a = operation(); await apply(a); await update(edit(a))
    await state.db.exec("DELETE FROM supplier_invoice_copy_receipts WHERE operation_type='supplier_invoice.updated'")
    await expect(apply(a)).rejects.toMatchObject({ status: 409 })
    expect((await lineRows())[0].qty).toBe('98.000')
  })

  it('rejects an older previously unseen legacy edit instead of rolling back a newer draft', async () => {
    const a = operation(); await apply(a)
    const b = edit(a); b.sequence = 10; delete b.payload.previous_invoice; await update(b)
    const older = edit(a); older.sequence = 5; delete older.payload.previous_invoice
    older.payload.notes = 'Стара правка'
    await expect(update(older)).rejects.toMatchObject({ status: 409 })
    expect((await invoiceRows())[0].notes).toBe('98 шт')
  })
  it.each(['device', 'sequence'])('rejects an acknowledgement replay with changed %s identity', async field => {
    const a = operation(); await apply(a)
    if (field === 'device') a.device_id = 'other-device'
    else a.sequence += 1
    await expect(apply(a)).rejects.toMatchObject({ status: 409 })
  })
  it('does not accept a legacy edit from a different device without a previous snapshot', async () => {
    const a = operation(); await apply(a)
    const b = edit(a); delete b.payload.previous_invoice; b.device_id = 'another-primary'
    await expect(update(b)).rejects.toMatchObject({ status: 409 })
    b.payload.previous_invoice = snapshot(a)
    await update(b); expect((await invoiceRows())[0].total).toBe(9800)
  })
  it('permits trusted server insert/read only, not modification of acknowledged receipts', async () => {
    const privileges = (await rows("SELECT has_table_privilege('service_role','supplier_invoice_copy_receipts','SELECT') AS read, has_table_privilege('service_role','supplier_invoice_copy_receipts','INSERT') AS write, has_table_privilege('service_role','supplier_invoice_copy_receipts','UPDATE') AS change, has_table_privilege('service_role','supplier_invoice_copy_receipts','DELETE') AS remove"))[0]
    expect(privileges).toEqual({ read: true, write: true, change: false, remove: false })
    expect((await rows("SELECT relrowsecurity FROM pg_class WHERE oid='supplier_invoice_copy_receipts'::regclass"))[0].relrowsecurity).toBe(true)
  })
  it('retains tenant-scoped acknowledgement cleanup before invoice cleanup in the explicit reset', () => {
    const code = readFileSync(new URL('../adminService.ts', import.meta.url), 'utf8')
    const mergeAt = code.indexOf("DELETE FROM supplier_merge_receipts WHERE tenant_id = $1")
    expect(mergeAt).toBeGreaterThan(0)
    expect(mergeAt).toBeLessThan(code.indexOf("DELETE FROM suppliers WHERE tenant_id = $1"))
    const receiptsAt = code.indexOf("DELETE FROM supplier_invoice_copy_receipts WHERE tenant_id = $1")
    expect(receiptsAt).toBeGreaterThan(0)
    expect(receiptsAt).toBeLessThan(code.indexOf("DELETE FROM supply_invoices WHERE tenant_id = $1"))
  })

  it('keeps receipt tenant isolation enforced by a database foreign key', async () => {
    const a = operation(); await apply(a)
    await expect(state.db.query('UPDATE supply_invoices SET tenant_id=$1', [other])).rejects.toMatchObject({ code: '23001' })
    await expect(state.db.query('INSERT INTO supplier_invoice_copy_receipts(tenant_id,operation_id,invoice_id,operation_type,payload_hash,document_hash,device_id,source_sequence) SELECT $1,$2,invoice_id,operation_type,payload_hash,document_hash,device_id,source_sequence FROM supplier_invoice_copy_receipts',
      [other, randomUUID()])).rejects.toMatchObject({ code: '23503' })
  })
  it.each(['anon', 'authenticated'])('does not let %s read or forge copy acknowledgements', async role => {
    const a = operation(); await apply(a)
    const privileges = (await rows("SELECT has_table_privilege($1,'supplier_invoice_copy_receipts','SELECT') AS read, has_table_privilege($1,'supplier_invoice_copy_receipts','INSERT') AS write", [role]))[0]
    expect(privileges).toEqual({ read: false, write: false })
    await state.db.exec('SET ROLE ' + role)
    try { await expect(rows('SELECT * FROM supplier_invoice_copy_receipts')).rejects.toMatchObject({ code: '42501' }) }
    finally { await state.db.exec('RESET ROLE') }
  })
})
