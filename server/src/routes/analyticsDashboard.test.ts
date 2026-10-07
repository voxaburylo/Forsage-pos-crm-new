import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, calls: 0, fail: false }))
vi.mock('../db/pg.js', () => ({ pool: { query: async (text: string, values: unknown[]) => {
  state.calls++
  if (state.fail) throw new Error('Report database unavailable')
  return state.db.query(text, values)
} } }))
vi.mock('../db/supabase.js', () => ({ db: {} }))
vi.mock('../middleware/auth.js', () => ({ requireAuth: vi.fn(), requireRole: () => vi.fn() }))
import router from './analytics.js'

const handler = (router as any).stack.find((layer: any) => layer.route?.path === '/dashboard').route.stack.at(-1).handle
async function dashboard(startDate = '2026-10-01', endDate = startDate, role = 'owner') {
  let result: any, error: any
  await handler({ user: { tenant_id: 'shop', role }, query: { startDate, endDate } },
    { json: (value: any) => { result = value.data } }, (value: any) => { error = value })
  if (error) throw error
  return result
}

beforeAll(async () => {
  state.db = new PGlite()
  await state.db.exec(`
    CREATE TABLE products (id text PRIMARY KEY, tenant_id text, purchase_price int, retail_price int,
      qty_on_hand numeric DEFAULT 0, reorder_point numeric DEFAULT 0, is_active boolean DEFAULT true,
      deleted_at timestamptz, is_service boolean DEFAULT false);
    CREATE TABLE sales (id text PRIMARY KEY, tenant_id text, total int, status text,
      completed_at timestamptz, created_at timestamptz);
    CREATE TABLE sale_items (id text PRIMARY KEY, tenant_id text, sale_id text, product_id text,
      qty numeric, cost_price int);
    CREATE TABLE returns (id text PRIMARY KEY, tenant_id text, sale_id text, status text,
      created_at timestamptz, stock_action text, refund_kopecks int, refund_amount int);
    CREATE TABLE return_items (id text PRIMARY KEY, tenant_id text, return_id text, sale_item_id text,
      quantity numeric, total_kopecks int);
    CREATE TABLE cash_operations (id text, tenant_id text, type text, expense_category_id text,
      created_at timestamptz, amount int);
    CREATE TABLE customers (id text, tenant_id text, deleted_at timestamptz, debt_balance int);
    CREATE TABLE suppliers (id text, tenant_id text, deleted_at timestamptz);
    CREATE TABLE customer_orders (id text, tenant_id text, deleted_at timestamptz, status text,
      pickup_deadline_at timestamptz);
  `)
}, 30000)
afterAll(async () => state.db?.close())
beforeEach(async () => {
  await state.db.exec('TRUNCATE products, sales, sale_items, returns, return_items, cash_operations, customers, suppliers, customer_orders')
  state.calls = 0; state.fail = false
})
async function sale(id = 'sale', opts: { tenant?: string; at?: string; total?: number; cost?: number; qty?: number; status?: string } = {}) {
  const { tenant = 'shop', at = '2026-10-01T10:00:00Z', total = 10000, cost = 6000, qty = 1, status = 'completed' } = opts
  await state.db.query('INSERT INTO products (id,tenant_id,purchase_price,retail_price) VALUES ($1,$2,99000,10000)', [id, tenant])
  await state.db.query('INSERT INTO sales VALUES ($1,$2,$3,$4,$5,$5)', [id, tenant, total, status, at])
  await state.db.query('INSERT INTO sale_items VALUES ($1,$2,$3,$4,$5,$6)', [id, tenant, id, id, qty, cost])
}
async function refund(id = 'refund', opts: { saleId?: string; tenant?: string; at?: string; amount?: number; qty?: number; action?: string; status?: string } = {}) {
  const { saleId = 'sale', tenant = 'shop', at = '2026-10-01T11:00:00Z', amount = 10000, qty = 1,
    action = 'return_to_stock', status = 'completed' } = opts
  await state.db.query('INSERT INTO returns VALUES ($1,$2,$3,$4,$5,$6,$7,$7)', [id, tenant, saleId, status, at, action, amount])
  await state.db.query('INSERT INTO return_items VALUES ($1,$2,$3,$4,$5,$6)', [id, tenant, id, saleId, qty, amount])
}

describe('actual dashboard route against isolated PostgreSQL', () => {
  it('keeps a recorded zero cost instead of replacing it with the current card price', async () => {
    await sale('zero', { cost: 0 })
    const result = await dashboard()
    expect(result).toMatchObject({ total_revenue: 10000, cogs: 0, gross_profit: 10000 })
  })
  it.each([['return_to_stock', 0], ['write_off', -6000], ['send_to_supplier', -6000]])(
    'counts same-day %s refund without inventing recovered cost', async (action, profit) => {
      await sale('sale', { status: 'returned' }); await refund('refund', { action: String(action) })
      const result = await dashboard()
      expect(result).toMatchObject({ total_revenue: 0, gross_profit: profit, total_receipts: 1 })
      expect(result.daily).toEqual([{ date: '2026-10-01', revenue: 0, profit }])
    })
  it.each([['return_to_stock', -4000], ['write_off', -10000], ['send_to_supplier', -10000]])(
    'puts a later %s refund on its own day even without sales', async (action, profit) => {
      await sale('sale', { status: 'returned' })
      await refund('refund', { action: String(action), at: '2026-10-02T11:00:00Z' })
      expect(await dashboard()).toMatchObject({ total_revenue: 10000, gross_profit: 4000 })
      const later = await dashboard('2026-10-02')
      expect(later).toMatchObject({ total_revenue: -10000, gross_profit: profit, total_receipts: 0, average_receipt: 0 })
      expect(later.daily).toEqual([{ date: '2026-10-02', revenue: -10000, profit }])
      expect((await dashboard('2026-10-01', '2026-10-02')).total_revenue).toBe(0)
    })
  it('does not multiply the refund header when several returned lines are present', async () => {
    await sale('sale', { qty: 2, total: 20000 })
    await refund('one', { amount: 20000 })
    await state.db.query('INSERT INTO return_items VALUES ($1,$2,$3,$4,$5,$6)', ['two', 'shop', 'one', 'sale', 1, 10000])
    expect(await dashboard()).toMatchObject({ total_revenue: 0, cogs: 0, gross_profit: 0, total_receipts: 1 })
  })
  it('keeps archived product history and uses captured fractional purchase cost', async () => {
    await sale('sale', { qty: 1.5, total: 15000 })
    await state.db.exec("UPDATE products SET deleted_at=now(),is_active=false,purchase_price=999999")
    expect(await dashboard()).toMatchObject({ total_revenue: 15000, cogs: 9000, gross_profit: 6000 })
  })
  it('ignores drafts, canceled refunds and all foreign-tenant rows', async () => {
    await sale(); await sale('draft', { status: 'draft' }); await sale('other', { tenant: 'elsewhere' })
    await refund('canceled', { status: 'canceled' }); await refund('foreign', { tenant: 'elsewhere' })
    await state.db.exec("INSERT INTO sale_items VALUES ('foreign-line','elsewhere','sale','sale',500,6000)")
    expect(await dashboard()).toMatchObject({ total_revenue: 10000, cogs: 6000, total_receipts: 1 })
  })
  it('rejects an unmatched returned line rather than assuming a zero cost', async () => {
    await sale(); await refund()
    await state.db.exec("UPDATE return_items SET sale_item_id='missing'")
    await expect(dashboard()).rejects.toThrow()
  })
  it('supports a legacy refund amount without treating an explicit zero as missing', async () => {
    await sale(); await refund()
    await state.db.exec('UPDATE returns SET refund_kopecks=NULL')
    expect((await dashboard()).total_revenue).toBe(0)
    await state.db.exec('UPDATE returns SET refund_kopecks=0')
    expect((await dashboard()).total_revenue).toBe(10000)
  })
  it.each([
    ['2026-07-31', '2026-07-30T21:00:00Z', '2026-07-31T21:00:00Z'],
    ['2026-01-15', '2026-01-14T22:00:00Z', '2026-01-15T22:00:00Z'],
    ['2026-03-29', '2026-03-28T22:00:00Z', '2026-03-29T21:00:00Z'],
    ['2026-10-25', '2026-10-24T21:00:00Z', '2026-10-25T22:00:00Z'],
  ])('uses the complete Kyiv day %s with an exclusive upper boundary', async (day, from, to) => {
    await sale('before', { at: new Date(Date.parse(from) - 1).toISOString() })
    await sale('first', { at: from })
    await sale('last', { at: new Date(Date.parse(to) - 1).toISOString() })
    await sale('after', { at: to })
    const result = await dashboard(day)
    expect(result).toMatchObject({ total_revenue: 20000, cogs: 12000, total_receipts: 2 })
    expect(result.daily).toEqual([{ date: day, revenue: 20000, profit: 8000 }])
  })
  it.each(['cashier', 'manager', 'storekeeper'])('does not leak daily profit to %s', async role => {
    await sale()
    const result = await dashboard('2026-10-01', '2026-10-01', role)
    expect(result).toMatchObject({ total_revenue: 10000, cogs: 0, gross_profit: 0, net_profit: 0 })
    expect(result.daily[0].profit).toBe(0)
  })
  it.each([
    ['2026-02-30', '2026-02-30'], ['2026-13-01', '2026-13-01'],
    ['2026-00-10', '2026-00-10'], ['not-a-day', '2026-10-01'],
    ['2026-10-02', '2026-10-01'], ['2026-10-01', '2026-02-29'],
  ])('rejects an invalid calendar period %s / %s before querying', async (start, end) => {
    await expect(dashboard(start, end)).rejects.toMatchObject({ status: 400 })
    expect(state.calls).toBe(0)
  })
  it('uses one read snapshot for daily totals, expenses, stock and debts', async () => {
    await sale()
    await state.db.exec(`INSERT INTO cash_operations VALUES ('expense','shop','out','category','2026-10-01T12:00:00Z',1000),
      ('outside','shop','out','category','2026-10-02T12:00:00Z',999999),
      ('foreign','elsewhere','out','category','2026-10-01T12:00:00Z',999999);
      INSERT INTO customers VALUES ('client','shop',NULL,1234),('foreign','elsewhere',NULL,999999);`)
    const result = await dashboard()
    expect(result).toMatchObject({ gross_profit: 4000, total_expenses: 1000, net_profit: 3000, debt: { count: 1, total: 1234 } })
    expect(state.calls).toBe(1)
  })
  it('reads over 1000 receipts without a REST row-limit truncation', async () => {
    await state.db.exec(`INSERT INTO sales SELECT 's'||n,'shop',100,'completed','2026-10-01T12:00:00Z','2026-10-01T12:00:00Z'
      FROM generate_series(1,1505) n;`)
    expect(await dashboard()).toMatchObject({ total_revenue: 150500, total_receipts: 1505 })
  })
  it('reports an empty day as a genuine zero but propagates a database failure', async () => {
    expect(await dashboard()).toMatchObject({ total_revenue: 0, total_receipts: 0, daily: [{ date: '2026-10-01', revenue: 0, profit: 0 }] })
    state.fail = true
    await expect(dashboard()).rejects.toThrow('Report database unavailable')
  })
  it('works in a read-only transaction without editing source documents', async () => {
    await sale(); await refund('r', { amount: 5000, qty: 0.5 })
    await state.db.exec('BEGIN READ ONLY')
    try { expect((await dashboard()).total_revenue).toBe(5000) }
    finally { await state.db.exec('ROLLBACK') }
    expect((await state.db.query('SELECT total FROM sales')).rows).toEqual([{ total: 10000 }])
  })
})
