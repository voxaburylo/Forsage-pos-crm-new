import { PGlite } from '@electric-sql/pglite'
import { beforeAll,beforeEach,afterAll,describe,expect,it,vi } from 'vitest'
const state = vi.hoisted(() => ({ db:null as any,calls:0,fail:false }))
vi.mock('../../db/pg.js', () => ({ pool:{query:async(sql:string,args:unknown[]) => {
 state.calls++; if(state.fail) throw Error('test unavailable'); return state.db.query(sql,args)
}} }))
vi.mock('../../db/supabase.js', () => ({ db:{from:vi.fn(() => {throw Error('REST must not be used for shift reports')})} }))
import { getShiftReport as analyticsShift } from '../reportService.js'
import { getShiftReport as cashShift,getShiftCashBreakdown } from '../shiftService.js'
import { aggregateShiftSnapshot } from '../../lib/shiftReport.js'
import { summarizePaymentReceipts } from '../cashAccounting.js'

const at='2026-10-04T10:00:00Z'
async function insert(table:string, row:Record<string,unknown>) {
 const keys=Object.keys(row)
 await state.db.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row))
}
async function shift(extra:Record<string,unknown>={}) {
 await insert('shifts',{id:'shift',tenant_id:'shop',cashier_id:'cashier',status:'closed',opening_cash:1000,
   opened_at:'2026-10-04T08:00:00Z',closed_at:'2026-10-04T18:00:00Z',...extra})
}
async function sale(extra:Record<string,unknown>={}) {
 await insert('sales',{id:'s',tenant_id:'shop',shift_id:'shift',sale_number:'S',total:6000,payment_method:'cash',
   cash_amount:6000,card_amount:0,transfer_amount:0,debt_amount:0,is_debt:false,is_fiscal:false,
   status:'returned',completed_at:at,...extra})
}
async function refund(extra:Record<string,unknown>={}) {
 await insert('returns',{id:'r',tenant_id:'shop',sale_id:'s',status:'completed',refund_amount:6000,
   refund_kopecks:6000,refund_method:'cash',approved_by:'cashier',created_at:at,...extra})
}
async function op(extra:Record<string,unknown>={}) {
 await insert('cash_operations',{id:'r',tenant_id:'shop',shift_id:'shift',type:'out',amount:6000,created_by:'cashier',...extra})
}
async function payment(extra:Record<string,unknown>={}) {
 await insert('order_payments',{id:'p',tenant_id:'shop',shift_id:'shift',order_id:'order',amount:6000,method:'cash',is_fiscal:false,...extra})
}
const run = (id='shift',tenant='shop') => cashShift(id,tenant)
beforeAll(async()=>{
 state.db=new PGlite()
 await state.db.exec(`
 CREATE TABLE shifts(id text primary key,tenant_id text,cashier_id text,status text,opening_cash numeric,opened_at timestamptz,closed_at timestamptz,deleted_at timestamptz);
 CREATE TABLE sales(id text primary key,tenant_id text,shift_id text,sale_number text,total numeric,payment_method text,
 cash_amount numeric,card_amount numeric,transfer_amount numeric,debt_amount numeric,is_debt bool,is_fiscal bool,status text,completed_at timestamptz,deleted_at timestamptz);
 CREATE TABLE cash_operations(id text primary key,tenant_id text,shift_id text,type text,amount numeric,created_by text,deleted_at timestamptz);
 CREATE TABLE returns(id text primary key,tenant_id text,sale_id text,status text,refund_amount numeric,refund_kopecks numeric,refund_method text,
 approved_by text,created_at timestamptz,shift_id text,deleted_at timestamptz,shift_link_recorded boolean DEFAULT false);
 CREATE TABLE customer_orders(id text primary key,tenant_id text,sale_id text,deleted_at timestamptz);
 CREATE TABLE order_payments(id text primary key,tenant_id text,shift_id text,order_id text,amount numeric,method text,is_fiscal bool,deleted_at timestamptz);
 `)
},30000)
beforeEach(async()=>{
 state.calls=0;state.fail=false
 await state.db.exec('TRUNCATE shifts,sales,cash_operations,returns,customer_orders,order_payments')
 await shift();await sale();await refund();await op()
})
afterAll(async()=>{await state.db?.close()})

describe('one consistent server shift snapshot',()=>{
 it('keeps gross receipt, deducts cash refund once and reads all parts in one statement',async()=>{
  const report=await run()
  expect(report).toMatchObject({total_sales:1,gross_revenue:6000,refund_total:6000,total_revenue:0,
    payment_received_total:6000,payment_refunded_total:6000,payment_net_total:0,unassigned_refunds_count:0,
    by_method:{cash:6000},refunds_by_method:{cash:6000},
    cash_breakdown:{opening_cash:1000,cash_sales:6000,cash_returns:6000,cash_out:0,expected_amount:1000}})
  expect(state.calls).toBe(1)
 })
 it('returns identical data for the cash register and analytics',async()=>{
  expect(await analyticsShift('shift','shop')).toEqual(await run());expect(state.calls).toBe(2)
 })
 it('reads opening cash from the same snapshot, not a stale caller value',async()=>{
  expect(await getShiftCashBreakdown('shift','shop',999999)).toMatchObject({opening_cash:1000,expected_amount:1000})
  expect(state.calls).toBe(1)
 })
 it('assigns a refund to its own later shift, not the receipt shift',async()=>{
  await shift({id:'later',opened_at:'2026-10-05T08:00:00Z',closed_at:'2026-10-05T18:00:00Z',opening_cash:10000})
  await state.db.exec("UPDATE cash_operations SET shift_id='later';UPDATE returns SET created_at='2026-10-05T10:00:00Z'")
  expect(await run()).toMatchObject({gross_revenue:6000,refund_total:0,total_revenue:6000,cash_breakdown:{expected_amount:7000}})
  expect(await run('later')).toMatchObject({total_sales:0,gross_revenue:0,total_revenue:-6000,payment_net_total:-6000,cash_breakdown:{expected_amount:4000}})
 })
 it.each([['cash','cash'],['terminal','card'],['credit','account'],['debt_reduction','debt']])('counts %s refund separately from receipts',async(method,bucket)=>{
  if(method!=='cash')await state.db.exec('DELETE FROM cash_operations')
  await state.db.query('UPDATE returns SET refund_method=$1',[method])
  const report=await run()
  expect(report.refunds_by_method[bucket as keyof typeof report.refunds_by_method]).toBe(6000)
  expect(report.payment_refunded_total).toBe(method==='debt_reduction'?0:6000)
 })
 it('uses an explicit terminal-return shift even when its approver or time does not match',async()=>{
  await state.db.exec("DELETE FROM cash_operations;UPDATE returns SET refund_method='terminal',shift_id='shift',approved_by='other',created_at='2026-10-05T10:00:00Z'")
  expect(await run()).toMatchObject({refund_total:6000,unassigned_refunds_count:0})
 })
 it('does not guess legacy refunds across overlapping cashier shifts',async()=>{
  await state.db.exec("DELETE FROM cash_operations;UPDATE returns SET refund_method='terminal'")
  await shift({id:'overlap'})
  expect(await run()).toMatchObject({refund_total:0,unassigned_refunds_count:1})
 })
 it('an exact cash link wins over overlapping intervals',async()=>{
  await shift({id:'overlap'})
  expect(await run()).toMatchObject({refund_total:6000,unassigned_refunds_count:0})
  expect(await run('overlap')).toMatchObject({refund_total:0,unassigned_refunds_count:0})
 })
 it.each(['missing','other-shop','conflict'])('does not guess a %s explicit refund link',async(kind)=>{
  if(kind==='other-shop')await shift({id:'linked',tenant_id:'alien'})
  if(kind==='conflict')await shift({id:'linked'})
  await state.db.exec("UPDATE returns SET shift_id='linked'")
  expect(await run()).toMatchObject({refund_total:0,unassigned_refunds_count:1})
 })
 it('warns about an unattributed refund instead of hiding it when its approver is not the cashier',async()=>{
  await state.db.exec("DELETE FROM cash_operations;UPDATE returns SET refund_method='terminal',approved_by='other'")
  expect(await run()).toMatchObject({refund_total:0,unassigned_refunds_count:1})
  await shift({id:'other-shift',cashier_id:'other'})
  // A unique other shift is not this drawer's refund or an unresolved warning.
  expect(await run()).toMatchObject({refund_total:0,unassigned_refunds_count:0})
 })
 it('distinguishes a confirmed outside-shift return from an unresolved legacy return',async()=>{
  await state.db.exec("DELETE FROM cash_operations;UPDATE returns SET refund_method='terminal',approved_by='other',shift_id=NULL,shift_link_recorded=true")
  expect(await run()).toMatchObject({refund_total:0,unassigned_refunds_count:0})
  await state.db.exec('UPDATE returns SET shift_link_recorded=false')
  expect(await run()).toMatchObject({refund_total:0,unassigned_refunds_count:1})
 })
 it('does not assign confirmed outside-shift returns by matching cashier and time',async()=>{
  await state.db.exec("DELETE FROM cash_operations;UPDATE returns SET refund_method='terminal',shift_id=NULL,shift_link_recorded=true")
  expect(await run()).toMatchObject({refund_total:0,unassigned_refunds_count:0})
 })
 it.each(['cash payout','linked operation'])('rejects confirmed absence contradicted by %s',async(kind)=>{
  await state.db.exec('UPDATE returns SET shift_id=NULL,shift_link_recorded=true')
  if(kind==='cash payout')await state.db.exec('DELETE FROM cash_operations')
  else await state.db.exec("UPDATE returns SET refund_method='terminal'")
  await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
 })
 it('allows legacy returns without a shift_id column and still uses cash evidence',async()=>{
  await state.db.exec('ALTER TABLE returns DROP COLUMN shift_id')
  try {expect(await run()).toMatchObject({refund_total:6000})}
  finally {await state.db.exec('ALTER TABLE returns ADD COLUMN shift_id text')}
 })
 it('handles zero activity explicitly',async()=>{
  await state.db.exec('TRUNCATE sales,returns,cash_operations')
  expect(await run()).toMatchObject({total_sales:0,total_revenue:0,payment_net_total:0,cash_breakdown:{expected_amount:1000}})
 })
 it('preserves a real shortage instead of clamping expected cash to zero',async()=>{
  await state.db.exec('DELETE FROM returns;DELETE FROM sales')
  expect((await run()).cash_breakdown.expected_amount).toBe(-5000)
 })
 it.each(['analytics','cash register','cash breakdown'])('%s fails on query errors, never returning false zeros',async(kind)=>{
  state.fail=true
  const promise=kind==='analytics'?analyticsShift('shift','shop'):kind==='cash register'?run():getShiftCashBreakdown('shift','shop',1000)
  await expect(promise).rejects.toThrow('test unavailable')
 })
 it.each(['missing','foreign','deleted'])('rejects %s shift',async(kind)=>{
  if(kind==='foreign')await state.db.exec("UPDATE shifts SET tenant_id='alien'")
  if(kind==='deleted')await state.db.exec('UPDATE shifts SET deleted_at=now()')
  await expect(run(kind==='missing'?'missing':'shift')).rejects.toMatchObject({code:'SHIFT_NOT_FOUND'})
 })
})

describe('receipt, prepayment and cash operation integrity',()=>{
 it.each([['analytics',analyticsShift],['cash register',cashShift]] as const)('%s preserves exact mixed split and debt',async(_label,report)=>{
  await state.db.exec("UPDATE sales SET status='completed',payment_method='mixed',total=10000,cash_amount=1000,card_amount=2000,transfer_amount=3000,debt_amount=4000,is_debt=true")
  expect(await report('shift','shop')).toMatchObject({by_method:{cash:1000,card:2000,transfer:3000,debt:4000,account:0},payment_received_total:6000})
 })
 it('recognizes explicitly marked legacy debt but refuses a false explicit zero',async()=>{
  await state.db.exec("UPDATE sales SET payment_method='mixed',cash_amount=1000,card_amount=2000,transfer_amount=0,debt_amount=NULL,is_debt=true")
  expect((await run()).by_method.debt).toBe(3000)
  await state.db.exec('UPDATE sales SET debt_amount=0')
  await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
 })
 it.each(['cash','card','transfer'])('recognizes %s legacy pure payments with unset split fields',async(method)=>{
  await state.db.query('UPDATE sales SET payment_method=$1,cash_amount=NULL,card_amount=NULL,transfer_amount=NULL',[method])
  expect((await run()).by_method[method as 'cash'|'card'|'transfer']).toBe(6000)
 })
 it('counts order prepayments once, even for archived orders and returned order receipts',async()=>{
  await insert('customer_orders',{id:'order',tenant_id:'shop',sale_id:'s',deleted_at:at});await payment()
  await op({id:'prepayment',type:'in'})
  const report=await run()
  expect(report).toMatchObject({gross_revenue:6000,total_revenue:0,by_method:{cash:6000},cash_breakdown:{cash_sales:0,cash_in:6000,cash_returns:6000,expected_amount:1000}})
  await state.db.exec("UPDATE order_payments SET shift_id='earlier';DELETE FROM cash_operations WHERE id='prepayment'")
  expect((await run()).by_method.cash).toBe(0)
 })
 it.each(['cash','card','transfer','account'])('includes %s order payments without a completed receipt',async(method)=>{
  await state.db.exec('TRUNCATE sales,returns,cash_operations')
  await insert('customer_orders',{id:'order',tenant_id:'shop',sale_id:null});await payment({method})
  if(method==='cash')await op({id:'prepayment',type:'in'})
  expect(await run()).toMatchObject({total_sales:0,payment_received_total:6000,by_method:{[method]:6000}})
 })
 it.each(['missing','foreign'])('refuses %s payment-order links',async(kind)=>{
  if(kind==='foreign')await insert('customer_orders',{id:'order',tenant_id:'alien',sale_id:'s'})
  await payment()
  await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
 })
 it('preserves fiscal receipt split without subtracting returns twice',async()=>{
  await state.db.exec("UPDATE sales SET is_fiscal=true,payment_method='mixed',cash_amount=1000,card_amount=2000,transfer_amount=3000")
  await insert('customer_orders',{id:'order',tenant_id:'shop',sale_id:null});await payment({method:'transfer',amount:500})
  expect((await run()).fiscal_breakdown).toEqual({cash_fiscal:1000,cash_non_fiscal:0,card_fiscal:2000,card_non_fiscal:0,transfer_fiscal:3000,transfer_non_fiscal:500,account_non_fiscal:0})
 })
 it('groups staff cash operations safely and never treats unknown operation types as payouts',async()=>{
  await op({id:'in',type:'in',amount:200,created_by:'__proto__'})
  expect((await run()).by_user).toContainEqual({user_id:'__proto__',cash_in:200,cash_out:0,count:1})
  await state.db.exec("UPDATE cash_operations SET type='correction' WHERE id='in'")
  await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
 })
 it.each(['sales','cash_operations','returns','order_payments'])('excludes deleted %s',async(table)=>{
  if(table==='order_payments'){await insert('customer_orders',{id:'order',tenant_id:'shop',sale_id:null});await payment({method:'card'})}
  await state.db.exec(`UPDATE ${table} SET deleted_at=now()`)
  if(table==='sales'||table==='cash_operations')await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
  else expect(await run()).toMatchObject(table==='returns'?{refund_total:0}:{by_method:{card:0}})
 })
 it('excludes drafts, cancelled returns and other tenants at every join',async()=>{
  await sale({id:'draft',status:'draft'});await sale({id:'alien',tenant_id:'alien'})
  await refund({id:'alien-r',tenant_id:'alien'});await op({id:'alien-op',tenant_id:'alien'})
  await payment({id:'alien-p',tenant_id:'alien'});await insert('customer_orders',{id:'alien-o',tenant_id:'alien',sale_id:'s'})
  expect(await run()).toMatchObject({total_sales:1,gross_revenue:6000,payment_received_total:6000,refund_total:6000,cash_breakdown:{expected_amount:1000}})
  await state.db.exec("UPDATE returns SET status='draft';DELETE FROM cash_operations")
  expect((await run()).refund_total).toBe(0)
 })
 it('does not hide rows after the REST page cap',async()=>{
  await state.db.exec(`TRUNCATE sales,returns,cash_operations;
  INSERT INTO sales(id,tenant_id,shift_id,sale_number,total,payment_method,cash_amount,card_amount,transfer_amount,debt_amount,is_debt,status,completed_at)
  SELECT 's'||i,'shop','shift','S'||i,100,'cash',100,0,0,0,false,'completed','2026-10-04T10:00:00Z' FROM generate_series(1,1205)i;
  INSERT INTO cash_operations(id,tenant_id,shift_id,type,amount,created_by) SELECT 'op'||i,'shop','shift','in',100,'cashier' FROM generate_series(1,605)i;`)
  expect(await run()).toMatchObject({total_sales:1205,gross_revenue:120500,cash_breakdown:{cash_in:60500,expected_amount:182000}})
  expect(state.calls).toBe(1)
 })
 it('includes every return beyond one page',async()=>{
  await state.db.exec(`TRUNCATE returns,cash_operations;UPDATE sales SET total=100000,cash_amount=100000;
  INSERT INTO returns(id,tenant_id,sale_id,status,refund_kopecks,refund_method,approved_by,created_at)
  SELECT 'r'||i,'shop','s','completed',100,'terminal','cashier','2026-10-04T10:00:00Z' FROM generate_series(1,605)i;`)
  expect(await run()).toMatchObject({refund_total:60500,total_revenue:39500})
 })
 it.each([
  "UPDATE sales SET total=-1","UPDATE sales SET total=1.5","UPDATE sales SET cash_amount=-1",
  "UPDATE sales SET payment_method='unknown'","UPDATE cash_operations SET amount=6001",
  "UPDATE cash_operations SET amount=NULL","UPDATE cash_operations SET amount=1.5",
  "UPDATE returns SET refund_method='unknown'","UPDATE returns SET sale_id='missing'",
  "UPDATE returns SET refund_kopecks=7000","UPDATE shifts SET opening_cash=9007199254740992",
 ])('refuses inconsistent stored data: %s',async(sql)=>{
  await state.db.exec(sql)
  await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
 })
 it('detects overflow in totals even when each receipt is safe',async()=>{
  await state.db.exec('DELETE FROM returns;DELETE FROM cash_operations;UPDATE sales SET total=9007199254740991,cash_amount=9007199254740991')
  await sale({id:'overflow',total:1,cash_amount:1})
  await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
 })
 it('rejects malformed snapshots rather than manufacturing empty reports',()=>{
  expect(()=>aggregateShiftSnapshot({},'shift','shop')).toThrow()
 })
 it('keeps the legacy payment helper explicit about debt metadata',()=>{
  const base={id:'s',total:10000,payment_method:'mixed',cash_amount:1000,card_amount:2000,transfer_amount:3000}
  expect(summarizePaymentReceipts([{...base,is_debt:true,debt_amount:null}],new Set(),[])).toMatchObject({debt:4000,total:6000})
  expect(summarizePaymentReceipts([{...base,is_debt:true,debt_amount:0}],new Set(),[]).debt).toBe(0)
  expect(summarizePaymentReceipts([base],new Set(),[]).debt).toBe(0)
 })
})
