import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, calls: 0, fail: false, roles: [] as string[][] }))
vi.mock('../db/pg.js', () => ({ pool: { query: async (sql: string, values: unknown[]) => {
  state.calls++
  if (state.fail) throw new Error('ABC database unavailable')
  return state.db.query(sql, values)
} } }))
vi.mock('../db/supabase.js', () => ({ db: {} }))
vi.mock('../middleware/auth.js', () => ({ requireAuth: vi.fn(), requireRole: (...roles: string[]) => {
  state.roles.push(roles); return vi.fn()
} }))
import router from './analytics.js'

const handler = (router as any).stack.find((layer: any) => layer.route?.path === '/abc').route.stack.at(-1).handle
async function abc(query: Record<string, unknown> = { days: '1' }) {
  let result: any, error: any
  await handler({ user: { tenant_id: 'shop', role: 'owner' }, query },
    { json: (value: any) => { result = value.data } }, (value: any) => { error = value })
  if (error) throw error
  return result as any[]
}
beforeAll(async () => {
  state.db = new PGlite()
  await state.db.exec(`
    CREATE TABLE products (id text PRIMARY KEY, tenant_id text, sku text, name text,
      qty_on_hand numeric DEFAULT 10, purchase_price int DEFAULT 99000, is_active boolean DEFAULT true,
      deleted_at timestamptz, is_service boolean DEFAULT false);
    CREATE TABLE sales (id text PRIMARY KEY, tenant_id text, total int, status text,
      completed_at timestamptz, created_at timestamptz);
    CREATE TABLE sale_items (id text PRIMARY KEY, tenant_id text, sale_id text, product_id text,
      qty numeric, unit_price int, total int, cost_price int, core_deposit_amount int DEFAULT 0);
    CREATE TABLE returns (id text PRIMARY KEY, tenant_id text, sale_id text, status text,
      created_at timestamptz, stock_action text, refund_kopecks int, refund_amount int);
    CREATE TABLE return_items (id text PRIMARY KEY, tenant_id text, return_id text, sale_item_id text,
      product_id text, quantity numeric, total_kopecks int);
    CREATE INDEX idx_sales_date ON sales(tenant_id,completed_at DESC);
    CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
    CREATE INDEX idx_sale_items_tenant_id ON sale_items(tenant_id);
  `)
}, 30000)
afterAll(async () => state.db?.close())
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-03T10:00:00Z'))
  await state.db.exec('TRUNCATE products,sales,sale_items,returns,return_items')
  state.calls = 0; state.fail = false
})
afterEach(() => vi.useRealTimers())
async function product(id = 'p', tenant = 'shop') {
  await state.db.query('INSERT INTO products (id,tenant_id,sku,name) VALUES ($1,$2,$1,$1)', [id, tenant])
}
async function sale(id = 's', opts: { at?: string; total?: number; cost?: number; qty?: number; status?: string; tenant?: string; productId?: string; lineTotal?: number } = {}) {
  const { at = '2026-10-03T10:00:00Z', total = 10000, cost = 6000, qty = 1, status = 'completed', tenant = 'shop', productId = 'p', lineTotal = total } = opts
  await state.db.query('INSERT INTO sales VALUES ($1,$2,$3,$4,$5,$5)', [id, tenant, total, status, at])
  await state.db.query('INSERT INTO sale_items (id,tenant_id,sale_id,product_id,qty,unit_price,total,cost_price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, tenant, id, productId, qty, Math.round(lineTotal / qty), lineTotal, cost])
}
async function refund(id = 'r', opts: { saleId?: string; at?: string; amount?: number; qty?: number; action?: string; status?: string; tenant?: string } = {}) {
  const { saleId = 's', at = '2026-10-03T12:00:00Z', amount = 10000, qty = 1, action = 'return_to_stock', status = 'completed', tenant = 'shop' } = opts
  await state.db.query('INSERT INTO returns VALUES ($1,$2,$3,$4,$5,$6,$7,$7)', [id, tenant, saleId, status, at, action, amount])
  await state.db.query('INSERT INTO return_items VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, tenant, id, saleId, 'p', qty, amount])
}

describe('ABC route reads actual PostgreSQL without touching live data', () => {
  it('only counts sales within the selected period, never old or future sales', async () => {
    await product(); await sale(); await sale('old', { at: '2026-06-01T10:00:00Z' }); await sale('future', { at: '2026-10-04T10:00:00Z' })
    expect((await abc())[0]).toMatchObject({ soldQty: 1, profit: 4000, abc_class: 'A', cumulative_pct: 100 })
  })
  it('uses captured purchase cost, not the current card price', async () => {
    await product(); await sale()
    expect((await abc())[0].profit).toBe(4000)
    await state.db.exec('UPDATE products SET purchase_price=123456')
    expect((await abc())[0].profit).toBe(4000)
  })
  it('preserves a recorded zero cost', async () => {
    await product(); await sale('s', { cost: 0 })
    expect((await abc())[0].profit).toBe(10000)
  })
  it('counts completed and returned receipts but ignores draft and canceled ones', async () => {
    await product(); await sale('s', { status: 'returned' }); await sale('draft', { status: 'draft' }); await sale('canceled', { status: 'canceled' })
    expect((await abc())[0]).toMatchObject({ soldQty: 1, profit: 4000 })
  })
  it('isolates product, sale, sale-item and return tenants', async () => {
    await product(); await product('foreign', 'other'); await sale()
    await sale('foreign-sale', { tenant: 'other' })
    await state.db.exec("INSERT INTO sale_items VALUES ('foreign-line','other','s','p',100,10000,1000000,6000,0)")
    await refund('foreign-return', { tenant: 'other' })
    expect(await abc()).toEqual([expect.objectContaining({ id: 'p', soldQty: 1, profit: 4000 })])
  })
  it.each([['return_to_stock', 0], ['write_off', -6000], ['send_to_supplier', -6000]])(
    'handles a complete same-day %s refund', async (action, profit) => {
      await product(); await sale('s', { status: 'returned' }); await refund('r', { action: String(action) })
      expect((await abc())[0]).toMatchObject({ soldQty: 0, profit, abc_class: 'Z' })
    })
  it.each([['return_to_stock', -4000], ['write_off', -10000], ['send_to_supplier', -10000]])(
    'places a later %s refund on its own day', async (action, profit) => {
      await product(); await sale('s', { at: '2026-10-02T10:00:00Z' }); await refund('r', { action: String(action) })
      expect((await abc())[0]).toMatchObject({ soldQty: -1, profit, abc_class: 'Z' })
    })
  it('does not subtract future or canceled returns from today', async () => {
    await product(); await sale(); await refund('future', { at: '2026-10-04T10:00:00Z' }); await refund('canceled', { status: 'canceled' })
    expect((await abc())[0]).toMatchObject({ soldQty: 1, profit: 4000 })
  })
  it('keeps quantities fractional and reverses only the returned quantity', async () => {
    await product(); await sale('s', { total: 15000, qty: 1.5 }); await refund('r', { amount: 5000, qty: .5 })
    expect((await abc())[0]).toMatchObject({ soldQty: 1, profit: 4000 })
  })
  it('allocates a receipt discount exactly once, including service and free-price lines', async () => {
    await product(); await product('p2'); await product('service')
    await state.db.exec("UPDATE products SET is_service=true WHERE id='service'")
    await sale('s', { total: 399, lineTotal: 100, cost: 60 })
    await state.db.exec("INSERT INTO sale_items VALUES ('b','shop','s','p2',1,100,100,60,0),('c','shop','s','service',1,100,100,0,0),('d','shop','s',NULL,1,100,100,0,0)")
    const rows = await abc()
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.id === 'p').profit).toBe(39)
    expect(rows.find(r => r.id === 'p2').profit).toBe(40)
  })
  it('protects a core-deposit share from ordinary discount allocation', async () => {
    await product(); await product('p2')
    await sale('s', { total: 201, lineTotal: 200, cost: 0 })
    await state.db.exec("UPDATE sale_items SET core_deposit_amount=100 WHERE id='s'; INSERT INTO sale_items VALUES ('b','shop','s','p2',1,100,100,0,0)")
    const rows = await abc()
    expect(rows.find(r => r.id === 'p').profit).toBe(150)
    expect(rows.find(r => r.id === 'p2').profit).toBe(51)
  })
  it('keeps archive history but excludes unrelated archived and unsold cards', async () => {
    await product(); await product('archived-unsold'); await product('active-unsold'); await sale()
    await state.db.exec("UPDATE products SET deleted_at=now(),is_active=false WHERE id<>'active-unsold'")
    const rows = await abc()
    expect(rows.map(r => r.id)).toEqual(['p', 'active-unsold'])
    expect(rows[0]).toMatchObject({ soldQty: 1, profit: 4000 })
  })
  it('includes an archived card in a refund-only period', async () => {
    await product(); await sale('s', { at: '2026-10-02T10:00:00Z' }); await refund()
    await state.db.exec("UPDATE products SET deleted_at=now(),is_active=false")
    expect((await abc())[0]).toMatchObject({ id: 'p', soldQty: -1, profit: -4000 })
  })
  it('classifies a dominant first product as A, and losses as Z', async () => {
    await product('p'); await product('b'); await product('c'); await product('loss')
    await sale('s', { cost: 0, total: 8000 }); await sale('b-sale', { productId: 'b', cost: 0, total: 1500 })
    await sale('c-sale', { productId: 'c', cost: 0, total: 500 }); await sale('loss-sale', { productId: 'loss', total: 100, cost: 500 })
    expect((await abc()).map(r => [r.id, r.abc_class, r.cumulative_pct])).toEqual([['p','A',80],['b','B',95],['c','C',100],['loss','Z',100]])
  })
  it.each(['missing-line', 'wrong-sale', 'wrong-product', 'missing-cost', 'empty-return', 'header-mismatch'])(
    'rejects incomplete refund data: %s instead of a plausible wrong total', async (fault) => {
      await product(); await sale(); await refund()
      const sql: Record<string, string> = {
        'missing-line': "UPDATE return_items SET sale_item_id='missing'",
        'wrong-sale': "UPDATE returns SET sale_id='missing'",
        'wrong-product': "UPDATE return_items SET product_id='different'",
        'missing-cost': "UPDATE sale_items SET cost_price=NULL",
        'empty-return': 'DELETE FROM return_items',
        'header-mismatch': 'UPDATE returns SET refund_kopecks=9000',
      }
      await state.db.exec(sql[fault])
      await expect(abc()).rejects.toThrow()
    })
  it('supports the legacy refund_amount field when refund_kopecks is null', async () => {
    await product(); await sale(); await refund()
    await state.db.exec('UPDATE returns SET refund_kopecks=NULL')
    expect((await abc())[0].profit).toBe(0)
  })
  it('rejects a missing sale line rather than inventing unsold stock', async () => {
    await product(); await sale(); await state.db.exec('DELETE FROM sale_items')
    await expect(abc()).rejects.toThrow()
  })
  it('rejects receipt totals not covered by their lines', async () => {
    await product(); await sale(); await state.db.exec('UPDATE sale_items SET total=1')
    await expect(abc()).rejects.toThrow()
  })
  it.each([
    ['2026-07-31', '2026-07-30T21:00:00Z', '2026-07-31T21:00:00Z'],
    ['2026-01-15', '2026-01-14T22:00:00Z', '2026-01-15T22:00:00Z'],
    ['2026-03-29', '2026-03-28T22:00:00Z', '2026-03-29T21:00:00Z'],
    ['2026-10-25', '2026-10-24T21:00:00Z', '2026-10-25T22:00:00Z'],
  ])('counts the whole Kyiv day %s, including DST', async (day, from, to) => {
    vi.setSystemTime(new Date(day + 'T10:00:00Z')); await product()
    await sale('before', { at: new Date(Date.parse(from)-1).toISOString() }); await sale('first', { at: from })
    await sale('last', { at: new Date(Date.parse(to)-1).toISOString() }); await sale('after', { at: to })
    expect((await abc())[0]).toMatchObject({ soldQty: 2, profit: 8000 })
  })
  it('defaults to exactly 90 calendar days, including today', async () => {
    await product(); await sale('outside', { at: '2026-07-05T20:59:59.999Z' }); await sale('first', { at: '2026-07-05T21:00:00Z' }); await sale()
    expect((await abc({}))[0].soldQty).toBe(2)
  })
  it.each(['0', '-1', '1.5', '90oops', '', 'NaN', 'Infinity', '3661', ['90'], { days: 1 }])(
    'rejects an invalid days parameter %j before querying', async days => {
      await expect(abc({ days })).rejects.toMatchObject({ status: 400 })
      expect(state.calls).toBe(0)
    })
  it('reads a single consistent snapshot and needs no write privileges', async () => {
    await product(); await sale()
    await state.db.exec('BEGIN READ ONLY')
    try { expect((await abc())[0].profit).toBe(4000) } finally { await state.db.exec('ROLLBACK') }
    expect(state.calls).toBe(1)
  })
  it('does not truncate after 1000 receipts', async () => {
    await product()
    await state.db.exec(`INSERT INTO sales SELECT 's'||n,'shop',100,'completed','2026-10-03T10:00:00Z','2026-10-03T10:00:00Z' FROM generate_series(1,1505)n;
      INSERT INTO sale_items SELECT 's'||n,'shop','s'||n,'p',1,100,100,60,0 FROM generate_series(1,1505)n`)
    await state.db.exec('ANALYZE sales; ANALYZE sale_items; ANALYZE products')
    expect((await abc())[0]).toMatchObject({ soldQty: 1505, profit: 60200 })
  })
  it('does not substitute an empty result when the database is unavailable', async () => {
    state.fail = true; await expect(abc()).rejects.toThrow('ABC database unavailable')
  })
  it('keeps the existing owner/admin access restriction', () => {
    expect(state.roles[0]).toEqual(['owner','admin'])
  })
})
