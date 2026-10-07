import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const state = vi.hoisted(() => ({ db: null as any, reverse: vi.fn(), queries: [] as string[] }))
vi.mock('../../db/supabase.js', () => ({ db: { from: () => ({
  select() { return this }, eq() { return this }, then(resolve: any) { resolve({ data: [], error: null }) },
}) } }))
vi.mock('../commissionService.js', () => ({ reverseCommissionForReturn: state.reverse }))
vi.mock('../../db/pg.js', () => ({ pool: {query:(sql:string,args:unknown[])=>state.db.query(sql,args)}, runTransaction: (fn: any) => state.db.transaction((tx: any) => fn({
  query: async (sql: string, args: any[]) => {
    state.queries.push(sql)
    const result = await tx.query(sql, args)
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }
  },
})) }))
import { applyReturnCreated } from '../sync/salesHandlers.js'

const tenant = randomUUID(), otherTenant = randomUUID(), user = randomUUID(), cashier = randomUUID()
const product = randomUUID(), customer = randomUUID(), sale = randomUUID(), line = randomUUID()
const oldShift = randomUUID(), returnShift = randomUUID()
const created = '2026-10-02T12:00:00.000Z'
function operation(method = 'terminal'): any {
  const id = randomUUID()
  return { sequence: 1, operation_id: randomUUID(), aggregate_id: id, aggregate_type: 'customer_return',
    operation_type: 'return.created', device_id: 'test', tenant_id: tenant, balance_mirrored: true,
    created_at: '2026-10-03T12:00:00Z', applied_at: '2026-10-03T12:00:00Z',
    payload: { id, sale_id: sale, approved_by: cashier, created_at: created,
      reason: 'other', reason_note: 'Тест', refund_method: method, stock_action: 'return_to_stock',
      refund_kopecks: 2250, shift_id: returnShift, fiscal_number: null,
      items: [{ id: randomUUID(), sale_item_id: line, product_id: product,
        quantity: 0.75, unit_price: 4000, total: 2250, condition: 'good' }] } }
}
const query = async (sql: string, args: any[] = []) => (await state.db.query(sql, args)).rows as any[]
beforeEach(async () => {
  state.reverse.mockReset(); state.queries = []; state.db = new PGlite()
  await state.db.exec(`
    CREATE TABLE customers(id uuid PRIMARY KEY,tenant_id uuid,debt_balance bigint,deposit_balance bigint,bonus_balance bigint,updated_at timestamptz);
    CREATE TABLE products(id uuid PRIMARY KEY,tenant_id uuid,qty_on_hand numeric,updated_at timestamptz,deleted_at timestamptz);
    CREATE TABLE shifts(id uuid PRIMARY KEY,tenant_id uuid,cashier_id uuid,status text,opening_cash bigint,
      closing_cash bigint,expected_cash bigint,cash_variance bigint,opened_at timestamptz,closed_at timestamptz,notes text,created_at timestamptz,updated_at timestamptz);
    CREATE TABLE sales(id uuid PRIMARY KEY,tenant_id uuid,sale_number text,customer_id uuid REFERENCES customers,shift_id uuid REFERENCES shifts,
      cashier_id uuid,status text,completed_at timestamptz,payment_method text,cash_amount bigint,total bigint,updated_at timestamptz);
    CREATE TABLE sale_items(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid REFERENCES sales,product_id uuid REFERENCES products,
      qty numeric,unit_price bigint,total bigint,discount bigint DEFAULT 0,core_deposit_amount bigint DEFAULT 0,created_at timestamptz);
    CREATE TABLE returns(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid REFERENCES sales,customer_id uuid REFERENCES customers,
      return_type text,reason text,reason_text text,reason_note text,refund_amount bigint,refund_kopecks bigint,refund_method text,
      stock_action text,status text,created_by uuid,approved_by uuid,fiscal_number text,created_at timestamptz,updated_at timestamptz);
    CREATE TABLE return_items(id uuid PRIMARY KEY,tenant_id uuid,return_id uuid REFERENCES returns,product_id uuid REFERENCES products,
      sale_item_id uuid REFERENCES sale_items,quantity numeric,unit_price_kopecks bigint,total_kopecks bigint,condition text,created_at timestamptz);
    CREATE TABLE cash_operations(id uuid PRIMARY KEY,tenant_id uuid,shift_id uuid REFERENCES shifts,type varchar(10),amount bigint CHECK(amount>0),
      note text,source varchar(30),created_by uuid,created_at timestamptz,updated_at timestamptz);
    CREATE TABLE customer_deposit_transactions(id uuid PRIMARY KEY,tenant_id uuid,customer_id uuid REFERENCES customers,amount bigint,
      balance_after bigint,method text,sale_id uuid,shift_id uuid,notes text,created_by uuid,created_at timestamptz,updated_at timestamptz);
    CREATE TABLE customer_orders(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid,deleted_at timestamptz,updated_at timestamptz);
    CREATE TABLE customer_order_items(id uuid PRIMARY KEY,order_id uuid REFERENCES customer_orders,product_id uuid,item_status text);
    CREATE TABLE order_activity_log(order_id uuid,user_id uuid,action text,details jsonb);
    INSERT INTO customers VALUES('${customer}','${tenant}',500,70,40,null);
    INSERT INTO products VALUES('${product}','${tenant}',3,null,now());
    INSERT INTO shifts(id,tenant_id,cashier_id,status,opening_cash,closing_cash,expected_cash,opened_at,closed_at)
      VALUES('${oldShift}','${tenant}','${cashier}','closed',0,0,0,'2026-10-01T08:00Z','2026-10-01T18:00Z'),
      ('${returnShift}','${tenant}','${cashier}','closed',0,0,0,'2026-10-02T08:00Z','2026-10-02T18:00Z');
    INSERT INTO sales VALUES('${sale}','${tenant}','COPY-TEST','${customer}','${oldShift}','${cashier}','completed',
      '2026-10-01T10:00Z','terminal',0,4500,null);
    INSERT INTO sale_items VALUES('${line}','${tenant}','${sale}','${product}',1.5,4000,6000,0,0,'2026-10-01T10:00Z');
  `)
  await state.db.exec(`ALTER TABLE sales ADD COLUMN card_amount bigint DEFAULT 4500,ADD COLUMN transfer_amount bigint DEFAULT 0,
    ADD COLUMN debt_amount bigint DEFAULT 0,ADD COLUMN is_debt boolean DEFAULT false,ADD COLUMN is_fiscal boolean DEFAULT false;
    UPDATE sales SET payment_method='card';
    CREATE TABLE order_payments(id uuid,tenant_id uuid,shift_id uuid,order_id uuid,amount bigint,method text,is_fiscal boolean);`)
  // Exercise the actual deployed refund trigger, not a no-op approximation.
  const migration = readFileSync(new URL('../../../../supabase/migrations/20260722213000_return_cash_operations.sql', import.meta.url), 'utf8')
  await state.db.exec(migration.split('REVOKE ALL')[0])
  await state.db.exec(`CREATE TRIGGER trg_return_cash_operation AFTER INSERT OR UPDATE OF status,refund_method,refund_kopecks,refund_amount
    ON returns FOR EACH ROW EXECUTE FUNCTION record_return_cash_operation();
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;`)
  await state.db.exec(readFileSync(new URL('../../../../supabase/migrations/20261005133848_return_copy_shift_identity.sql',import.meta.url),'utf8'))
})
afterEach(async () => { await state.db.close() })

describe('local returns are copied, never refunded or stocked a second time', () => {
  it('preserves fractional quantities, receipt discount, actor and original date', async () => {
    const op = operation()
    await applyReturnCreated(tenant, user, op)
    const [header] = await query('SELECT * FROM returns')
    expect(Number(header.refund_kopecks)).toBe(2250)
    expect(header.approved_by).toBe(cashier)
    expect(header.shift_id).toBe(returnShift); expect(header.shift_link_recorded).toBe(true)
    expect(header.created_at.toISOString()).toBe(created)
    const [item] = await query('SELECT * FROM return_items')
    expect(Number(item.quantity)).toBe(0.75); expect(Number(item.total_kopecks)).toBe(2250)
    expect(Number((await query('SELECT qty_on_hand FROM products'))[0].qty_on_hand)).toBe(3)
  })
  it('copies cash into its original closed shift without checking todays cash or moving the sale', async () => {
    const op = operation('cash')
    await applyReturnCreated(tenant, user, op)
    expect((await query('SELECT shift_id FROM sales'))[0].shift_id).toBe(oldShift)
    expect(await query('SELECT * FROM shifts')).toHaveLength(2)
    expect(await query('SELECT id,shift_id,type,amount,created_by FROM cash_operations')).toEqual([
      { id: op.aggregate_id, shift_id: returnShift, type: 'out', amount: 2250, created_by: cashier },
    ])
  })
  it('does not reduce an already mirrored customer debt again', async () => {
    await applyReturnCreated(tenant, user, operation('debt_reduction'))
    expect(Number((await query('SELECT debt_balance FROM customers'))[0].debt_balance)).toBe(500)
  })
  it('copies the historical credit balance, not the current customer balance', async () => {
    const op = operation('credit')
    op.payload.deposit_transaction = { id: randomUUID(), balance_after: 2500 }
    await applyReturnCreated(tenant, user, op)
    const [row] = await query('SELECT * FROM customer_deposit_transactions')
    expect(row.id).toBe(op.payload.deposit_transaction.id)
    expect(Number(row.amount)).toBe(2250); expect(Number(row.balance_after)).toBe(2500)
    expect(Number((await query('SELECT deposit_balance FROM customers'))[0].deposit_balance)).toBe(70)
  })
  it('does not recalculate local salary reversals on the server', async () => {
    await applyReturnCreated(tenant, user, operation())
    expect(state.reverse).not.toHaveBeenCalled()
  })
  it('retries exactly once and refuses a different sum under the same return ID', async () => {
    const op = operation('cash')
    await applyReturnCreated(tenant, user, op); await applyReturnCreated(tenant, user, op)
    expect(await query('SELECT * FROM returns')).toHaveLength(1)
    expect(await query('SELECT * FROM return_items')).toHaveLength(1)
    expect(await query('SELECT * FROM cash_operations')).toHaveLength(1)
    op.payload.refund_kopecks = op.payload.items[0].total = 2200
    await expect(applyReturnCreated(tenant, user, op)).rejects.toThrow()
    expect(Number((await query('SELECT amount FROM cash_operations'))[0].amount)).toBe(2250)
  })

  it.each(['return_to_stock', 'write_off', 'send_to_supplier'])('keeps canonical stock for %s', async action => {
    const op = operation(); op.payload.stock_action = action
    await applyReturnCreated(tenant, user, op)
    expect(Number((await query('SELECT qty_on_hand FROM products'))[0].qty_on_hand)).toBe(3)
    expect(state.queries.some(sql => /UPDATE\s+(products|customers|shifts)\b/i.test(sql))).toBe(false)
  })
  it('keeps the original sale and all shift totals even when the return date is later than close', async () => {
    const op = operation('cash'); op.payload.created_at = '2026-10-02T22:00:00Z'
    const before = await query('SELECT * FROM shifts ORDER BY id')
    await applyReturnCreated(tenant, user, op)
    expect(await query('SELECT * FROM shifts ORDER BY id')).toEqual(before)
    expect((await query('SELECT shift_id FROM sales'))[0].shift_id).toBe(oldShift)
  })
  it('two partial refunds preserve every kopeck and mark the original receipt fully returned', async () => {
    const first = operation(), second = operation()
    await applyReturnCreated(tenant, user, first)
    expect((await query('SELECT status FROM sales'))[0].status).toBe('completed')
    await applyReturnCreated(tenant, user, second)
    expect((await query('SELECT status FROM sales'))[0].status).toBe('returned')
    expect(Number((await query('SELECT SUM(refund_kopecks) total FROM returns'))[0].total)).toBe(4500)
    await expect(applyReturnCreated(tenant, user, operation())).rejects.toThrow()
    expect(await query('SELECT * FROM returns')).toHaveLength(2)
  })
  it('publishes a fully returned order item through its parent timestamp, once and only in its tenant', async () => {
    const order = randomUUID(), foreign = randomUUID()
    for (const [id, owner] of [[order, tenant], [foreign, otherTenant]]) {
      await query('INSERT INTO customer_orders(id,tenant_id,sale_id) VALUES($1,$2,$3)', [id, owner, sale])
      await query("INSERT INTO customer_order_items(id,order_id,product_id,item_status) VALUES($1,$2,$3,'issued')", [randomUUID(), id, product])
    }
    const op = operation(); op.payload.items[0].quantity = 1.5; op.payload.items[0].total = op.payload.refund_kopecks = 4500
    await applyReturnCreated(tenant, user, op); await applyReturnCreated(tenant, user, op)
    expect((await query('SELECT item_status FROM customer_order_items WHERE order_id=$1', [order]))[0].item_status).toBe('returned')
    expect((await query('SELECT updated_at FROM customer_orders WHERE id=$1', [order]))[0].updated_at.toISOString()).toBe('2026-10-03T12:00:00.000Z')
    expect((await query('SELECT item_status FROM customer_order_items WHERE order_id=$1', [foreign]))[0].item_status).toBe('issued')
    expect((await query('SELECT updated_at FROM customer_orders WHERE id=$1', [foreign]))[0].updated_at).toBeNull()
    expect(await query('SELECT * FROM order_activity_log')).toHaveLength(1)
  })
  it('keeps a receipt with an unreturned service line completed', async () => {
    const service = randomUUID()
    await query('INSERT INTO products(id,tenant_id,qty_on_hand) VALUES($1,$2,0)', [service, tenant])
    await query('INSERT INTO sale_items(id,tenant_id,sale_id,product_id,qty,unit_price,total) VALUES($1,$2,$3,$4,1,100,100)',
      [randomUUID(), tenant, sale, service])
    const op = operation(); op.payload.items[0].quantity = 1.5; op.payload.items[0].total = op.payload.refund_kopecks = 4500
    await applyReturnCreated(tenant, user, op)
    expect((await query('SELECT status FROM sales'))[0].status).toBe('completed')
  })
  it('does not substitute a different sale line for the same product', async () => {
    const op = operation(); op.payload.items[0].sale_item_id = randomUUID()
    await expect(applyReturnCreated(tenant, user, op)).rejects.toThrow('точну позицію')
    expect(await query('SELECT * FROM returns')).toHaveLength(0)
  })
  it.each(['cash', 'credit', 'debt_reduction', 'terminal'])('rejects another tenants receipt for %s', async method => {
    const op = operation(method); op.tenant_id = otherTenant
    if (method === 'credit') op.payload.deposit_transaction = { id: randomUUID(), balance_after: 2250 }
    await expect(applyReturnCreated(otherTenant, user, op)).rejects.toThrow()
    expect(await query('SELECT * FROM returns')).toHaveLength(0)
  })
  it.each(['shifts', 'products', 'customers', 'sale_items'])('rejects cross-tenant %s references', async table => {
    await query(`UPDATE ${table} SET tenant_id=$1`, [otherTenant])
    await expect(applyReturnCreated(tenant, user, operation('cash'))).rejects.toThrow()
    expect(await query('SELECT * FROM returns')).toHaveLength(0)
  })
  it.each([
    ['missing line amount', (p: any) => { delete p.items[0].total }],
    ['wrong header sum', (p: any) => { p.refund_kopecks++ }],
    ['negative refund', (p: any) => { p.items[0].total = p.refund_kopecks = -1 }],
    ['fractional kopeck', (p: any) => { p.items[0].total = p.refund_kopecks = 1.5 }],
    ['null quantity', (p: any) => { p.items[0].quantity = null }],
    ['over-precise quantity', (p: any) => { p.items[0].quantity = 0.0001 }],
    ['too much quantity', (p: any) => { p.items[0].quantity = 2 }],
    ['wrong source price', (p: any) => { p.items[0].unit_price++ }],
    ['excess receipt refund', (p: any) => { p.items[0].total = p.refund_kopecks = 4501 }],
    ['unknown refund method', (p: any) => { p.refund_method = 'other' }],
    ['unknown stock action', (p: any) => { p.stock_action = 'none' }],
    ['duplicate line', (p: any) => { p.items.push({ ...p.items[0], id: randomUUID() }); p.refund_kopecks *= 2 }],
    ['invalid date', (p: any) => { p.created_at = 'not-a-date' }],
    ['wrong product', (p: any) => { p.items[0].product_id = randomUUID() }],
    ['missing cash shift', (p: any) => { p.refund_method = 'cash'; delete p.shift_id }],
    ['unknown cash shift', (p: any) => { p.refund_method = 'cash'; p.shift_id = randomUUID() }],
    ['missing credit history', (p: any) => { p.refund_method = 'credit' }],
  ])('rejects %s without a partial document', async (_label, change) => {
    const op = operation(); (change as (p: any) => void)(op.payload)
    await expect(applyReturnCreated(tenant, user, op)).rejects.toThrow()
    for (const table of ['returns', 'return_items', 'cash_operations', 'customer_deposit_transactions']) {
      expect(await query(`SELECT * FROM ${table}`)).toHaveLength(0)
    }
  })
  it.each(['refund_method', 'stock_action', 'approved_by', 'created_at'])('detects changed %s on redelivery', async field => {
    const op = operation(); await applyReturnCreated(tenant, user, op)
    const changed: any = { refund_method: 'debt_reduction', stock_action: 'write_off', approved_by: user, created_at: '2026-10-02T13:00:00Z' }
    op.payload[field] = changed[field]
    await expect(applyReturnCreated(tenant, user, op)).rejects.toThrow('відрізняється')
    expect(await query('SELECT * FROM returns')).toHaveLength(1)
  })
  it('detects changed return items even when the total is unchanged', async () => {
    const op = operation(); await applyReturnCreated(tenant, user, op)
    op.payload.items[0].quantity = 0.5
    await expect(applyReturnCreated(tenant, user, op)).rejects.toThrow('відрізняється')
  })
  it('rolls back the complete return when its cash operation cannot be written', async () => {
    await state.db.exec(`CREATE FUNCTION fail_cash() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test disk failure'; END; $$;
      CREATE TRIGGER test_failure BEFORE INSERT ON cash_operations FOR EACH ROW EXECUTE FUNCTION fail_cash();`)
    await expect(applyReturnCreated(tenant, user, operation('cash'))).rejects.toThrow('test disk failure')
    expect(await query('SELECT * FROM returns')).toHaveLength(0)
    expect(await query('SELECT * FROM return_items')).toHaveLength(0)
  })
  it('does not acknowledge a conflicting cash operation or change another tenant', async () => {
    const op = operation('cash')
    await query("INSERT INTO cash_operations(id,tenant_id,amount,type) VALUES($1,$2,1,'out')", [op.aggregate_id, otherTenant])
    await expect(applyReturnCreated(tenant, user, op)).rejects.toThrow('відрізняється')
    expect(await query('SELECT * FROM returns')).toHaveLength(0)
    expect(Number((await query('SELECT amount FROM cash_operations'))[0].amount)).toBe(1)
  })
  it('does not duplicate historical credit on redelivery even after current balance changes', async () => {
    const op = operation('credit'); op.payload.deposit_transaction = { id: randomUUID(), balance_after: 2500 }
    await applyReturnCreated(tenant, user, op)
    await query('UPDATE customers SET deposit_balance=0')
    await applyReturnCreated(tenant, user, op)
    expect(await query('SELECT * FROM customer_deposit_transactions')).toHaveLength(1)
    expect(Number((await query('SELECT deposit_balance FROM customers'))[0].deposit_balance)).toBe(0)
  })
  it('rejects conflicting historical credit balances rather than overwrite them', async () => {
    const op = operation('credit'); op.payload.deposit_transaction = { id: randomUUID(), balance_after: 2500 }
    await applyReturnCreated(tenant, user, op)
    op.payload.deposit_transaction.balance_after++
    await expect(applyReturnCreated(tenant, user, op)).rejects.toThrow('відрізняється')
  })
  it('allows a zero-price terminal return without manufacturing a cash payment', async () => {
    const op = operation(); op.payload.refund_kopecks = op.payload.items[0].total = 0
    await applyReturnCreated(tenant, user, op)
    expect(await query('SELECT * FROM returns')).toHaveLength(1)
    expect(await query('SELECT * FROM cash_operations')).toHaveLength(0)
  })
  it('does not recalculate balances even for an unsigned legacy document copy', async () => {
    const op = operation(); delete op.balance_mirrored
    await applyReturnCreated(tenant, user, op)
    expect(Number((await query('SELECT qty_on_hand FROM products'))[0].qty_on_hand)).toBe(3)
    expect(state.reverse).not.toHaveBeenCalled()
  })
})

describe('exact return shift copy identity', () => {
  async function legacyStored(op:any) {
    await applyReturnCreated(tenant,user,op)
    // Simulate a row written before the metadata columns existed.
    await state.db.exec('ALTER TABLE returns DISABLE TRIGGER trg_return_shift_identity')
    await query('UPDATE returns SET shift_id=NULL,shift_link_recorded=false WHERE id=$1',[op.aggregate_id])
    await state.db.exec('ALTER TABLE returns ENABLE TRIGGER trg_return_shift_identity')
  }
  it.each(['cash','terminal','credit','debt_reduction'])('stores the original closed shift for %s',async method=>{
    const op=operation(method)
    if(method==='credit')op.payload.deposit_transaction={id:randomUUID(),balance_after:2500}
    await applyReturnCreated(tenant,user,op)
    expect(await query('SELECT shift_id,shift_link_recorded FROM returns')).toEqual([{shift_id:returnShift,shift_link_recorded:true}])
  })
  it('preserves an explicitly recorded return outside a shift',async()=>{
    const op=operation();op.payload.shift_id=null;op.payload.shift_link_recorded=true
    await applyReturnCreated(tenant,user,op);await applyReturnCreated(tenant,user,op)
    expect(await query('SELECT shift_id,shift_link_recorded FROM returns')).toEqual([{shift_id:null,shift_link_recorded:true}])
  })
  it('does not call an omitted legacy shift a confirmed outside-shift return',async()=>{
    const op=operation();delete op.payload.shift_id
    await applyReturnCreated(tenant,user,op)
    expect(await query('SELECT shift_id,shift_link_recorded FROM returns')).toEqual([{shift_id:null,shift_link_recorded:false}])
  })
  it.each(['replace','clear','erase provenance'])('refuses to %s an already recorded return shift',async kind=>{
    const op=operation();await applyReturnCreated(tenant,user,op)
    if(kind==='replace')op.payload.shift_id=oldShift
    if(kind==='clear'){op.payload.shift_id=null;op.payload.shift_link_recorded=true}
    if(kind==='erase provenance')delete op.payload.shift_id
    await expect(applyReturnCreated(tenant,user,op)).rejects.toMatchObject({status:409})
    expect((await query('SELECT shift_id FROM returns'))[0].shift_id).toBe(returnShift)
  })
  it('does not move a known outside-shift return into a new shift on retry',async()=>{
    const op=operation();op.payload.shift_id=null;op.payload.shift_link_recorded=true
    await applyReturnCreated(tenant,user,op);op.payload.shift_id=returnShift
    await expect(applyReturnCreated(tenant,user,op)).rejects.toThrow('відрізняється')
    expect((await query('SELECT shift_id FROM returns'))[0].shift_id).toBeNull()
  })
  it('does not infer confirmed absence from a malformed payload with a missing shift field',async()=>{
    const op=operation();delete op.payload.shift_id;op.payload.shift_link_recorded=true
    await expect(applyReturnCreated(tenant,user,op)).rejects.toThrow('явного номера')
    expect(await query('SELECT * FROM returns')).toEqual([])
  })
  it('rejects contradictory provenance before any document is stored',async()=>{
    const op=operation();op.payload.shift_link_recorded=false
    await expect(applyReturnCreated(tenant,user,op)).rejects.toThrow('суперечить')
    expect(await query('SELECT * FROM returns')).toEqual([])
  })
  it.each(['cash','terminal','credit'])('enriches an identical old %s copy without replaying money or stock',async method=>{
    const op=operation(method)
    if(method==='credit')op.payload.deposit_transaction={id:randomUUID(),balance_after:2500}
    await legacyStored(op)
    const before:Record<string,any>={}
    for(const table of ['products','customers','sales','shifts','return_items','cash_operations','customer_deposit_transactions'])before[table]=await query('SELECT * FROM '+table)
    op.applied_at='2026-10-05T12:00:00Z'
    await applyReturnCreated(tenant,user,op);await applyReturnCreated(tenant,user,op)
    expect(await query('SELECT shift_id,shift_link_recorded,updated_at FROM returns')).toEqual([
      {shift_id:returnShift,shift_link_recorded:true,updated_at:new Date(op.applied_at)}])
    for(const [table,rows] of Object.entries(before))expect(await query('SELECT * FROM '+table)).toEqual(rows)
  })
  it.each(['header','line','missing cash','wrong cash'])('does not enrich a legacy copy with %s inconsistency',async kind=>{
    const op=operation('cash');await legacyStored(op)
    if(kind==='header')op.payload.reason_note='Different'
    if(kind==='line')op.payload.items[0].quantity=.5
    if(kind==='missing cash')await query('DELETE FROM cash_operations')
    if(kind==='wrong cash')await query('UPDATE cash_operations SET amount=1')
    await expect(applyReturnCreated(tenant,user,op)).rejects.toThrow('відрізняється')
    expect(await query('SELECT shift_id,shift_link_recorded FROM returns')).toEqual([{shift_id:null,shift_link_recorded:false}])
  })
  it('rolls back metadata enrichment when the update fails',async()=>{
    const op=operation('cash');await legacyStored(op)
    await state.db.exec(`CREATE FUNCTION fail_link() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test link failure';END;$$;
      CREATE TRIGGER test_link_failure BEFORE UPDATE OF shift_id ON returns FOR EACH ROW EXECUTE FUNCTION fail_link();`)
    await expect(applyReturnCreated(tenant,user,op)).rejects.toThrow('test link failure')
    expect(await query('SELECT shift_id,shift_link_recorded FROM returns')).toEqual([{shift_id:null,shift_link_recorded:false}])
    expect((await query('SELECT count(*) n FROM cash_operations'))[0].n).toBe(1)
  })
  it('rejects a deleted shift, preserving the pending local copy',async()=>{
    await state.db.exec('ALTER TABLE shifts ADD COLUMN deleted_at timestamptz')
    await query('UPDATE shifts SET deleted_at=now() WHERE id=$1',[returnShift])
    await expect(applyReturnCreated(tenant,user,operation())).rejects.toThrow('Спочатку потрібно передати')
    expect(await query('SELECT * FROM returns')).toEqual([])
  })
  it('keeps one document and one cash operation under concurrent retries',async()=>{
    const op=operation('cash')
    await Promise.all([applyReturnCreated(tenant,user,op),applyReturnCreated(tenant,user,op)])
    expect(await query('SELECT id FROM returns')).toHaveLength(1)
    expect(await query('SELECT id FROM cash_operations')).toHaveLength(1)
  })
  it('reports a copied terminal refund in its exact shift even outside its interval and under another approver',async()=>{
    const op=operation();op.payload.approved_by=user;op.payload.created_at='2026-10-02T22:00:00Z'
    await applyReturnCreated(tenant,user,op)
    const {readShiftReport}=await import('../shiftReport.js')
    expect(await readShiftReport(returnShift,tenant)).toMatchObject({gross_revenue:0,refund_total:2250,total_revenue:-2250,
      refunds_by_method:{card:2250},unassigned_refunds_count:0})
    expect(await readShiftReport(oldShift,tenant)).toMatchObject({gross_revenue:4500,refund_total:0,total_revenue:4500})
  })
  it('does not warn or subtract a confirmed outside-shift copy in an overlapping shift report',async()=>{
    const op=operation();op.payload.shift_id=null;op.payload.shift_link_recorded=true
    await applyReturnCreated(tenant,user,op)
    const {readShiftReport}=await import('../shiftReport.js')
    expect(await readShiftReport(returnShift,tenant)).toMatchObject({refund_total:0,unassigned_refunds_count:0})
  })
})
