import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LocalDatabase } from '../../../../apps/desktop/src/db/localDatabase'
import { LocalPosRepository } from '../../../../apps/desktop/src/repositories/posRepository'
import { LocalCatalogRepository } from '../../../../apps/desktop/src/repositories/catalogRepository'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('../../db/supabase.js', () => ({ db: {} }))
vi.mock('../../db/pg.js', () => ({ pool: {}, runTransaction: (fn: any) => state.db.transaction((tx: any) => fn({
  query: async (sql: string, args: any[]) => {
    const result = await tx.query(sql, args)
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }
  },
})) }))
import { applySaleCompleted } from '../sync/salesHandlers.js'

const tenant = randomUUID(), product = randomUUID(), shift = randomUUID(), user = randomUUID()
const sale = () => ({ sequence: 1, operation_id: randomUUID(), tenant_id: tenant, device_id: 'test',
  aggregate_type: 'sale', aggregate_id: randomUUID(), operation_type: 'sale.completed',
  created_at: '2026-09-11T18:00:00Z', payload: {
    shift_id: shift, cashier_id: user, sale_number: randomUUID(), subtotal: 6000, discount: 0,
    total: 6000, payment_method: 'cash', payments: [{ method: 'cash', amount: 6000 }],
    completed_at: '2026-09-11T11:00:00Z', bonuses_spent: 500,
    items: [{ id: randomUUID(), product_id: product, qty: 2, unit_price: 3000,
      purchase_price: 1200, total: 6000, core_deposit_amount: 0 }],
  } })

beforeEach(async () => {
  state.db = new PGlite()
  await state.db.exec(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_app_meta_data jsonb);
    INSERT INTO auth.users VALUES('${user}','{"tenant_id":"${tenant}"}');
    CREATE TABLE shifts(id uuid PRIMARY KEY, tenant_id uuid, status text);
    CREATE TABLE products(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, qty_on_hand numeric, deleted_at timestamptz,
      sku text, name text, barcode text, retail_price int,purchase_price int,unit text,is_active boolean,is_service boolean,
      notes text,created_at timestamptz,updated_at timestamptz,UNIQUE(tenant_id,sku));
    CREATE TABLE customers(id uuid PRIMARY KEY, tenant_id uuid, bonus_balance int, debt_balance int);
    CREATE TABLE sales(id uuid PRIMARY KEY, tenant_id uuid, sale_number text, customer_id uuid,
      cashier_id uuid, shift_id uuid REFERENCES shifts, status text, subtotal bigint, discount bigint,
      total bigint, payment_method text, is_debt boolean, notes text, manager_id uuid, cash_amount bigint,
      card_amount bigint, transfer_amount bigint, bonuses_spent bigint, is_fiscal boolean, fiscal_number text,
      fiscal_qr_url text, completed_at timestamptz, created_at timestamptz, updated_at timestamptz);
    CREATE TABLE sale_items(id uuid PRIMARY KEY, tenant_id uuid, sale_id uuid REFERENCES sales,
      product_id uuid REFERENCES products, qty numeric, unit_price bigint, discount bigint, total bigint,
      cost_price bigint, core_deposit_amount bigint, core_return_status text, created_at timestamptz);
    INSERT INTO shifts VALUES ('${shift}', '${tenant}', 'closed');
    INSERT INTO products(id,tenant_id,qty_on_hand,deleted_at) VALUES ('${product}', '${tenant}', 0, now());
    INSERT INTO customers VALUES ('${user}', '${tenant}', 0, 1000);
  `)
  await state.db.exec(readFileSync(new URL('../../../../supabase/migrations/20261004174013_sale_copy_payment_integrity.sql', import.meta.url),'utf8'))
})
afterEach(async () => { await state.db.close() })

describe('completed local receipts are copied, not sold again', () => {
  it.each(['cash','transfer','mixed'])('round-trips a REAL local %s checkout and its queued payload',async kind=>{
    const root=mkdtempSync(path.join(tmpdir(),'forsage-sale-copy-contract-'))
    const local=new LocalDatabase(root)
    try{
      const at=new Date().toISOString()
      local.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES(?,?,?,\'cashier\',?,?)')
        .run(user,tenant,'Касир',at,at)
      local.prepare('INSERT INTO customers(id,tenant_id,full_name,phone,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(user,tenant,'Клієнт','+380670001234',at,at)
      const pos=new LocalPosRepository(local)
      const localShift=pos.openShift({tenant_id:tenant,cashier_id:user,opening_cash:1000})
      const localProduct=new LocalCatalogRepository(local).upsertProduct({tenant_id:tenant,id:product,
        sku:'ROUNDTRIP',name:'Олива',unit:'л',qty_on_hand:2,retail_price:100,purchase_price:20}).id
      const payments:any=kind==='mixed'?[{method:'cash',amount:11},{method:'transfer',amount:10},{method:'debt',amount:8}]
        :[{method:kind,amount:29}]
      const checkout=pos.checkout({tenant_id:tenant,cashier_id:user,customer_id:user,shift_id:localShift,
        notes:'Збережений коментар',items:[{product_id:localProduct,qty:.3,unit_price:100}],discount:1,payments})
      const queued:any=local.prepare("SELECT * FROM sync_outbox WHERE operation_type='sale.completed' AND aggregate_id=?").get(checkout.sale_id)
      const op={...queued,payload:JSON.parse(queued.payload_json)}
      const original=JSON.stringify(local.prepare('SELECT * FROM sales').all())
      const stock=local.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(product)
      await state.db.query('INSERT INTO shifts VALUES($1,$2,$3)',[localShift,tenant,'closed'])
      await applySaleCompleted(tenant,user,op);await applySaleCompleted(tenant,randomUUID(),op)
      const copied=(await state.db.query('SELECT * FROM sales')).rows[0]
      expect(copied).toMatchObject({id:checkout.sale_id,subtotal:30,discount:1,total:29,
        shift_id:localShift,notes:'Збережений коментар',cashier_id:user,debt_amount:kind==='mixed'?8:0})
      const line=(await state.db.query('SELECT * FROM sale_items')).rows[0]
      expect(Number(line.qty)).toBe(.3);expect(Number(line.total)).toBe(30);expect(line.id).toBe(op.payload.items[0].id)
      expect(line.created_at.toISOString()).toBe(op.payload.completed_at)
      expect(JSON.stringify(local.prepare('SELECT * FROM sales').all())).toBe(original)
      expect(local.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(product)).toEqual(stock)
      expect(Number((await state.db.query('SELECT qty_on_hand FROM products WHERE id=$1',[product])).rows[0].qty_on_hand)).toBe(0)
    }finally{
      local.close()
      if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-sale-copy-contract-'))
        rmSync(root,{recursive:true,force:true})
    }
  })
  it('copies a free amount exactly once without touching physical stock',async()=>{
    const op:any=sale();op.payload.items[0].product_id=null
    await applySaleCompleted(tenant,user,op);await applySaleCompleted(tenant,user,op)
    const free=(await state.db.query("SELECT * FROM products WHERE sku='LOCAL-FREE-AMOUNT'")).rows
    expect(free).toHaveLength(1);expect(free[0].is_service).toBe(true)
    expect(Number(free[0].qty_on_hand)).toBe(0)
    expect((await state.db.query('SELECT product_id FROM sale_items')).rows[0].product_id).toBe(free[0].id)
  })
  it('does not restore an archived free-amount service on retry',async()=>{
    const op:any=sale();op.payload.items[0].product_id=null
    await applySaleCompleted(tenant,user,op)
    await state.db.exec("UPDATE products SET deleted_at='2026-09-12T10:00:00Z',is_active=false WHERE sku='LOCAL-FREE-AMOUNT'")
    const before=(await state.db.query("SELECT * FROM products WHERE sku='LOCAL-FREE-AMOUNT'")).rows
    await applySaleCompleted(tenant,user,op)
    expect((await state.db.query("SELECT * FROM products WHERE sku='LOCAL-FREE-AMOUNT'")).rows).toEqual(before)
  })
  it('does not repurpose a physical product using the reserved service SKU',async()=>{
    const op:any=sale();op.payload.items[0].product_id=null
    await state.db.exec("UPDATE products SET sku='LOCAL-FREE-AMOUNT',is_service=false,qty_on_hand=5")
    const before=(await state.db.query('SELECT * FROM products')).rows
    await expect(applySaleCompleted(tenant,user,op)).rejects.toMatchObject({code:'SYNC_FREE_AMOUNT_PRODUCT_CONFLICT'})
    expect((await state.db.query('SELECT * FROM products')).rows).toEqual(before)
    expect((await state.db.query('SELECT * FROM sales')).rows).toHaveLength(0)
  })

  it.each([
    ['cash', [{method:'cash',amount:6000}], [6000,0,0,0]],
    ['card', [{method:'card',amount:6000}], [0,6000,0,0]],
    ['transfer', [{method:'transfer',amount:6000}], [0,0,6000,0]],
    ['debt', [{method:'debt',amount:6000}], [0,0,0,6000]],
    ['mixed', [{method:'cash',amount:2000},{method:'transfer',amount:4000}], [2000,0,4000,0]],
    ['mixed', [{method:'cash',amount:2000},{method:'debt',amount:4000}], [2000,0,0,4000]],
    ['mixed', [{method:'cash',amount:1000},{method:'card',amount:1000},{method:'transfer',amount:2000},{method:'debt',amount:2000}], [1000,1000,2000,2000]],
    ['cash', [{method:'cash',amount:2000},{method:'cash',amount:4000}], [6000,0,0,0]],
  ])('preserves the complete %s split under real payment constraints', async (method,payments,expected) => {
    const op:any=sale(); op.payload.customer_id=user;op.payload.payment_method=method;op.payload.payments=payments
    await applySaleCompleted(tenant,user,op);await applySaleCompleted(tenant,user,op)
    const row=(await state.db.query('SELECT * FROM sales')).rows[0]
    expect([row.cash_amount,row.card_amount,row.transfer_amount,row.debt_amount].map(Number)).toEqual(expected)
    expect((await state.db.query('SELECT * FROM customers')).rows[0]).toMatchObject({debt_balance:1000,bonus_balance:0})
  })
  it.each([
    ['cashier_id',()=>randomUUID()],['manager_id',()=>randomUUID()],['shift_id',()=>randomUUID()],
    ['customer_id',()=>randomUUID()],['sale_number',()=>'OTHER'],['notes',()=>'Other note'],
    ['completed_at',()=>'2026-09-10T10:00:00Z'],['created_at',()=>'2026-09-10T10:00:00Z'],
    ['bonuses_spent',()=>600],['fiscal_number',()=>'OTHER-FISCAL'],
  ])('does not acknowledge drift in saved %s',async(field,value)=>{
    const op=sale();await applySaleCompleted(tenant,user,op)
    // Shift/customer FK references must exist to simulate a valid but wrong link.
    const changed=value()
    if(field==='shift_id')await state.db.query('INSERT INTO shifts VALUES($1,$2,$3)',[changed,tenant,'closed'])
    await state.db.query('UPDATE sales SET '+field+'=$1',[changed])
    await expect(applySaleCompleted(tenant,user,op)).rejects.toMatchObject({code:'SYNC_SALE_COPY_CONFLICT'})
  })
  it.each([
    ['missing item identity',(p:any)=>{delete p.items[0].id}],
    ['unknown payment method',(p:any)=>{p.payments[0].method='crypto'}],
    ['different declared method',(p:any)=>{p.payment_method='card'}],
    ['fractional kopecks',(p:any)=>{p.payments[0].amount=5999.5}],
    ['too many quantity decimals',(p:any)=>{p.items[0].qty=2.0001}],
    ['quantity below one thousandth',(p:any)=>{p.items[0].qty=1e-12}],
    ['nonexistent date',(p:any)=>{p.completed_at='2026-02-30T12:00:00Z'}],
    ['duplicate item ID',(p:any)=>{p.items.push({...p.items[0]})}],
    ['debt without customer',(p:any)=>{p.payment_method='debt';p.payments[0].method='debt'}],
    ['conflicting cost fields',(p:any)=>{p.items[0].cost_price=900}],
    ['non-numeric money',(p:any)=>{p.total='6000'}],
    ['negative discount',(p:any)=>{p.discount=-1}],
  ])('rejects %s atomically',async(_label,change)=>{
    const op=sale();change(op.payload)
    await expect(applySaleCompleted(tenant,user,op)).rejects.toMatchObject({code:'SYNC_SALE_INVALID'})
    expect((await state.db.query('SELECT * FROM sales')).rows).toHaveLength(0)
    expect((await state.db.query('SELECT * FROM sale_items')).rows).toHaveLength(0)
  })
  it('keeps fractional quantities, receipt and line discounts, core and notes',async()=>{
    const op:any=sale();op.payload.customer_id=user;op.payload.notes='Коментар касира'
    op.payload.items[0]={...op.payload.items[0],qty:1.5,unit_price:101,discount:2,total:153,core_deposit_amount:2}
    op.payload.subtotal=155;op.payload.discount=5;op.payload.total=150;op.payload.payments[0].amount=150
    op.payload.is_fiscal=true;op.payload.fiscal_number='FISCAL-1';op.payload.fiscal_qr_url='https://example.test/receipt'
    await applySaleCompleted(tenant,user,op);await applySaleCompleted(tenant,randomUUID(),op)
    const row=(await state.db.query('SELECT * FROM sales')).rows[0]
    expect(row).toMatchObject({cashier_id:user,manager_id:null,notes:'Коментар касира',total:150,discount:5,fiscal_number:'FISCAL-1'})
    expect((await state.db.query('SELECT * FROM sale_items')).rows[0]).toMatchObject({qty:'1.5',total:153,discount:2,core_deposit_amount:2})
  })
  it('accepts redelivery after a full return without reverting its status',async()=>{
    const op=sale();await applySaleCompleted(tenant,user,op)
    await state.db.exec("UPDATE sales SET status='returned'")
    await applySaleCompleted(tenant,user,op)
    expect((await state.db.query('SELECT status FROM sales')).rows[0].status).toBe('returned')
  })
  it('does not reset a legitimate completed core return',async()=>{
    const op:any=sale();op.payload.items[0].core_deposit_amount=50;op.payload.items[0].total=6100
    op.payload.subtotal=op.payload.total=op.payload.payments[0].amount=6100
    await applySaleCompleted(tenant,user,op)
    await state.db.exec("UPDATE sale_items SET core_return_status='refunded'")
    await applySaleCompleted(tenant,user,op)
    expect((await state.db.query('SELECT core_return_status FROM sale_items')).rows[0].core_return_status).toBe('refunded')
  })
  it('keeps a NULL legacy debt split without changing the historical row',async()=>{
    const op:any=sale();op.payload.customer_id=user;op.payload.payment_method='mixed'
    op.payload.payments=[{method:'cash',amount:2000},{method:'debt',amount:4000}]
    await applySaleCompleted(tenant,user,op);await state.db.exec('UPDATE sales SET debt_amount=NULL')
    await applySaleCompleted(tenant,user,op)
    expect((await state.db.query('SELECT debt_amount FROM sales')).rows[0].debt_amount).toBeNull()
  })
  it('allows the historical cashier fallback for a missing manager only',async()=>{
    const op=sale();await applySaleCompleted(tenant,user,op)
    await state.db.query('UPDATE sales SET manager_id=$1',[user])
    await applySaleCompleted(tenant,randomUUID(),op)
    expect((await state.db.query('SELECT manager_id FROM sales')).rows[0].manager_id).toBe(user)
  })
  it('rejects another tenant operation and another tenants existing sale ID',async()=>{
    const op=sale();const other=randomUUID()
    await expect(applySaleCompleted(other,user,op)).rejects.toMatchObject({code:'SYNC_SALE_INVALID'})
    await applySaleCompleted(tenant,user,op);await state.db.query('UPDATE sales SET tenant_id=$1',[other])
    await expect(applySaleCompleted(tenant,user,op)).rejects.toMatchObject({code:'SYNC_SALE_COPY_CONFLICT'})
  })
  it.each(['customer','staff'])('requires a %s from the same tenant',async kind=>{
    const op:any=sale();op.payload.customer_id=user
    if(kind==='customer')await state.db.query('UPDATE customers SET tenant_id=$1',[randomUUID()])
    else await state.db.query('UPDATE auth.users SET raw_app_meta_data=$1',[{tenant_id:randomUUID()}])
    await expect(applySaleCompleted(tenant,user,op)).rejects.toMatchObject({code:kind==='customer'?'SYNC_SALE_CUSTOMER_REQUIRED':'SYNC_SALE_STAFF_REQUIRED'})
    expect((await state.db.query('SELECT * FROM sales')).rows).toHaveLength(0)
  })
  it('does not manufacture an actor from editable user metadata',async()=>{
    const op=sale()
    await state.db.exec('ALTER TABLE auth.users ADD raw_user_meta_data jsonb')
    await state.db.query('UPDATE auth.users SET raw_app_meta_data=$1,raw_user_meta_data=$2',[{}, {tenant_id:tenant}])
    await expect(applySaleCompleted(tenant,user,op)).rejects.toMatchObject({code:'SYNC_SALE_STAFF_REQUIRED'})
  })
  it('does not accept another receipts line IDs or extra stored rows',async()=>{
    const op=sale();await applySaleCompleted(tenant,user,op)
    const other=sale();other.payload.items[0].id=op.payload.items[0].id
    await expect(applySaleCompleted(tenant,user,other)).rejects.toMatchObject({code:'SYNC_SALE_COPY_CONFLICT'})
    await state.db.query('INSERT INTO sale_items SELECT $1::uuid,tenant_id,sale_id,product_id,qty,unit_price,discount,total,cost_price,core_deposit_amount,core_return_status,created_at FROM sale_items',[randomUUID()])
    await expect(applySaleCompleted(tenant,user,op)).rejects.toMatchObject({code:'SYNC_SALE_COPY_CONFLICT'})
  })
  it('rolls back the entire copy if a line write fails',async()=>{
    const op=sale()
    await state.db.exec(`CREATE FUNCTION fail_line() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test line failure'; END; $$;
      CREATE TRIGGER fail_line BEFORE INSERT ON sale_items FOR EACH ROW EXECUTE FUNCTION fail_line();`)
    await expect(applySaleCompleted(tenant,user,op)).rejects.toThrow('test line failure')
    expect((await state.db.query('SELECT * FROM sales')).rows).toHaveLength(0)
    expect(Number((await state.db.query('SELECT qty_on_hand FROM products')).rows[0].qty_on_hand)).toBe(0)
  })
  it('does not acknowledge an existing receipt with missing lines', async () => {
    const op = sale(); await applySaleCompleted(tenant, user, op)
    await state.db.exec('DELETE FROM sale_items')
    await expect(applySaleCompleted(tenant, user, op)).rejects.toMatchObject({ code: 'SYNC_SALE_COPY_CONFLICT' })
  })
  it('does not acknowledge a changed product quantity under the same total', async () => {
    const op = sale(); await applySaleCompleted(tenant, user, op)
    await state.db.exec('UPDATE sale_items SET qty=1')
    await expect(applySaleCompleted(tenant, user, op)).rejects.toMatchObject({ code: 'SYNC_SALE_COPY_CONFLICT' })
  })
  it('does not acknowledge a changed payment split under the same total', async () => {
    const op = sale(); await applySaleCompleted(tenant, user, op)
    await state.db.exec("UPDATE sales SET payment_method='card',cash_amount=0,card_amount=6000")
    await expect(applySaleCompleted(tenant, user, op)).rejects.toMatchObject({ code: 'SYNC_SALE_COPY_CONFLICT' })
  })
  it('rejects a payment shortfall without creating a receipt', async () => {
    const op = sale(); op.payload.payments[0].amount = 4000
    await expect(applySaleCompleted(tenant, user, op)).rejects.toMatchObject({ code: 'SYNC_SALE_INVALID' })
    expect((await state.db.query('SELECT * FROM sales')).rows).toHaveLength(0)
  })
  it('rejects a sale ID that differs from the acknowledged document ID', async () => {
    const op = sale(); (op.payload as any).sale_id = randomUUID()
    await expect(applySaleCompleted(tenant, user, op)).rejects.toMatchObject({ code: 'SYNC_SALE_INVALID' })
  })
  it('rejects receipt lines that do not cover its recorded subtotal', async () => {
    const op = sale(); op.payload.items[0].total = 5000
    await expect(applySaleCompleted(tenant, user, op)).rejects.toMatchObject({ code: 'SYNC_SALE_INVALID' })
  })
  it('copies a historical receipt against closed shift and deleted/zero-stock product, exactly once', async () => {
    const op = sale()
    await applySaleCompleted(tenant, user, op)
    await applySaleCompleted(tenant, user, op)
    const rows = (await state.db.query('SELECT * FROM sales')).rows
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].total)).toBe(6000)
    expect(rows[0].completed_at.toISOString()).toBe('2026-09-11T11:00:00.000Z')
    expect(rows[0].shift_id).toBe(shift)
    expect((await state.db.query('SELECT * FROM sale_items')).rows).toHaveLength(1)
    expect(Number((await state.db.query('SELECT qty_on_hand FROM products')).rows[0].qty_on_hand)).toBe(0)
    expect((await state.db.query('SELECT * FROM customers')).rows[0]).toMatchObject({ bonus_balance: 0, debt_balance: 1000 })
    expect((await state.db.query('SELECT status FROM shifts')).rows[0].status).toBe('closed')
  })
  it('rolls back a receipt whose product has not arrived yet', async () => {
    const op = sale(); op.payload.items[0].product_id = randomUUID()
    await expect(applySaleCompleted(tenant, user, op)).rejects.toThrow('Не передано картку товару')
    expect((await state.db.query('SELECT * FROM sales')).rows).toHaveLength(0)
  })
  it('refuses conflicting totals on redelivery', async () => {
    const op = sale(); await applySaleCompleted(tenant, user, op)
    op.payload.total = op.payload.payments[0].amount = 1
    op.payload.discount = 5999
    await expect(applySaleCompleted(tenant, user, op)).rejects.toThrow('іншу суму')
  })
  it('does not manufacture a new shift to fit a receipt', async () => {
    const op = sale(); op.payload.shift_id = randomUUID()
    await expect(applySaleCompleted(tenant, user, op)).rejects.toThrow('копію касової зміни')
    expect((await state.db.query('SELECT * FROM sales')).rows).toHaveLength(0)
  })
  it('rejects invalid quantities before writing', async () => {
    const op = sale(); op.payload.items[0].qty = -1
    await expect(applySaleCompleted(tenant, user, op)).rejects.toThrow('кількість')
    expect((await state.db.query('SELECT * FROM sales')).rows).toHaveLength(0)
  })
})
