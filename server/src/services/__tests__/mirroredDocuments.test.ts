import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
const state=vi.hoisted(()=>({db:null as any}))
vi.mock('../../db/supabase.js',()=>({db:{}}))
vi.mock('../../db/pg.js',()=>({pool:{},runTransaction:(fn:any)=>state.db.transaction((tx:any)=>fn({query:async(sql:string,args:any[])=>{
  const r=await tx.query(sql,args);return {...r,rowCount:r.rows.length||r.affectedRows||0}
}}))}))
import { applyCustomerDebtPaid, applyCustomerDepositChanged, applyCustomerBonusAdjusted } from '../sync/customerHandlers.js'
import { applyWriteoffCreated } from '../sync/inventoryHandlers.js'
import { applySupplierInvoicePosted, applySupplierInvoiceCancelled } from '../sync/supplierHandlers.js'
const tenant=randomUUID(),customer=randomUUID(),product=randomUUID(),user=randomUUID(),shift=randomUUID()
const op=(payload:any={})=>({operation_id:randomUUID(),sequence:1,tenant_id:tenant,device_id:'primary',aggregate_type:'customer',aggregate_id:customer,operation_type:'test',created_at:'2026-09-11T12:00:00Z',balance_mirrored:true,payload})
beforeEach(async()=>{
  state.db=new PGlite()
  await state.db.exec(`CREATE TABLE customers(id uuid PRIMARY KEY,tenant_id uuid,full_name text,phone text,debt_balance bigint,deposit_balance bigint,bonus_balance bigint,updated_at timestamptz,deleted_at timestamptz);
    INSERT INTO customers VALUES('${customer}','${tenant}','Test','test',0,0,0,null,null);
    CREATE TABLE idempotency_keys(key text,tenant_id uuid,response jsonb,created_at timestamptz,PRIMARY KEY(key,tenant_id));
    CREATE TABLE cash_operations(id uuid PRIMARY KEY,tenant_id uuid,shift_id uuid,type text,amount bigint,note text,created_by uuid,created_at timestamptz,updated_at timestamptz);
    CREATE TABLE customer_deposit_transactions(id uuid PRIMARY KEY,tenant_id uuid,customer_id uuid,amount bigint,balance_after bigint,method text,order_id uuid,sale_id uuid,shift_id uuid,notes text,created_by uuid,created_at timestamptz,updated_at timestamptz);
    CREATE TABLE bonus_transactions(id uuid PRIMARY KEY,tenant_id uuid,customer_id uuid,amount bigint,transaction_type text,description text,created_by uuid,created_at timestamptz,updated_at timestamptz);
    CREATE TABLE products(id uuid PRIMARY KEY,tenant_id uuid,purchase_price bigint,qty_on_hand numeric,updated_at timestamptz,deleted_at timestamptz);
    INSERT INTO products VALUES('${product}','${tenant}',100,0,null,null);
    CREATE TABLE inventory_writeoffs(id uuid PRIMARY KEY,tenant_id uuid,reason text,notes text,created_by uuid,created_at timestamptz,updated_at timestamptz);
    CREATE TABLE inventory_writeoff_items(id uuid PRIMARY KEY,writeoff_id uuid,product_id uuid,qty numeric,cost_kopecks bigint,created_at timestamptz);
    CREATE TABLE supply_invoices(id uuid PRIMARY KEY,tenant_id uuid,status text,paid_amount bigint,posted_by uuid,posted_at timestamptz,updated_at timestamptz,deleted_at timestamptz);`)
})
afterEach(async()=>state.db.close())
describe('documents after canonical balances were already applied',()=>{
  it('copies the entire debt payment even when the latest debt is zero, once',async()=>{
    const operation=op({amount:5000,method:'cash',shift_id:shift})
    await applyCustomerDebtPaid(tenant,user,operation);await applyCustomerDebtPaid(tenant,user,operation)
    expect((await state.db.query('SELECT amount FROM cash_operations')).rows.map((r:any)=>Number(r.amount))).toEqual([5000])
    expect(Number((await state.db.query('SELECT debt_balance FROM customers')).rows[0].debt_balance)).toBe(0)
  })
  it('copies a historic withdrawal without withdrawing it twice from the current balance',async()=>{
    const operation=op({amount:-3000,method:'cash',shift_id:shift,balance_after:2000})
    await applyCustomerDepositChanged(tenant,user,operation);await applyCustomerDepositChanged(tenant,user,operation)
    const rows=(await state.db.query('SELECT amount,balance_after FROM customer_deposit_transactions')).rows
    expect(rows.map((r:any)=>[Number(r.amount),Number(r.balance_after)])).toEqual([[-3000,2000]])
    expect(Number((await state.db.query('SELECT deposit_balance FROM customers')).rows[0].deposit_balance)).toBe(0)
    expect((await state.db.query('SELECT type,amount FROM cash_operations')).rows).toHaveLength(1)
  })
  it('copies a bonus debit when the balance has already reached zero',async()=>{
    const operation=op({amount:-100})
    await applyCustomerBonusAdjusted(tenant,user,operation);await applyCustomerBonusAdjusted(tenant,user,operation)
    expect((await state.db.query('SELECT amount FROM bonus_transactions')).rows).toHaveLength(1)
    expect(Number((await state.db.query('SELECT bonus_balance FROM customers')).rows[0].bonus_balance)).toBe(0)
  })
  it('copies an already applied writeoff without checking or consuming stock again',async()=>{
    const operation=op({items:[{product_id:product,qty:8}]});operation.aggregate_id=randomUUID()
    await applyWriteoffCreated(tenant,user,operation);await applyWriteoffCreated(tenant,user,operation)
    expect((await state.db.query('SELECT qty FROM inventory_writeoff_items')).rows.map((r:any)=>Number(r.qty))).toEqual([8])
    expect(Number((await state.db.query('SELECT qty_on_hand FROM products')).rows[0].qty_on_hand)).toBe(0)
  })
  it('copies invoice posting and cancellation without invoking stock RPCs',async()=>{
    const operation=op({});operation.aggregate_id=randomUUID()
    await state.db.query("INSERT INTO supply_invoices(id,tenant_id,status,paid_amount) VALUES($1,$2,'draft',0)",[operation.aggregate_id,tenant])
    await applySupplierInvoicePosted(tenant,user,operation);await applySupplierInvoicePosted(tenant,user,operation)
    expect((await state.db.query('SELECT status FROM supply_invoices')).rows[0].status).toBe('posted')
    await applySupplierInvoiceCancelled(tenant,operation);await applySupplierInvoiceCancelled(tenant,operation)
    expect((await state.db.query('SELECT status FROM supply_invoices')).rows[0].status).toBe('cancelled')
    expect(Number((await state.db.query('SELECT qty_on_hand FROM products')).rows[0].qty_on_hand)).toBe(0)
  })
})
