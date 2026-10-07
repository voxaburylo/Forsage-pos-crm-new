import { PGlite } from '@electric-sql/pglite'
import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, calls: 0, fail: false, roles: [] as string[][] }))
vi.mock('../db/pg.js', () => ({ pool: { query: async (sql: string, values: unknown[]) => {
  state.calls++
  if (state.fail) throw new Error('database unavailable')
  return state.db.query(sql, values)
} } }))
vi.mock('../db/supabase.js', () => ({ db: {} }))
vi.mock('../middleware/auth.js', () => ({ requireAuth: vi.fn(), requireRole: (...roles: string[]) => {
  state.roles.push(roles); return vi.fn()
} }))
import router from './analytics.js'
const handlers = Object.fromEntries(['staff-kpi', 'staff-profitability'].map(kind =>
  [kind, (router as any).stack.find((layer: any) => layer.route?.path === '/' + kind).route.stack.at(-1).handle]))
async function report(kind = 'staff-profitability', query: unknown = { startDate: '2026-10-04', endDate: '2026-10-04' }) {
  let data: any, error: any
  await handlers[kind]({ user: { tenant_id: 'shop', role: 'owner' }, query },
    { json: (result: any) => { data = result.data } }, (err: any) => { error = err })
  if (error) throw error
  return data as any[]
}
const employee = async (id: string, tenant = 'shop', archived = false) =>
  state.db.query(`INSERT INTO auth.users VALUES ($1,$2::jsonb,$3::jsonb)`,
    [id, JSON.stringify({ tenant_id: tenant, deleted_at: archived ? '2026-10-01' : null, role: 'cashier' }),
      JSON.stringify({ full_name: 'Працівник ' + id })])
async function sale(id = 's', opts: { at?: string; total?: number; cost?: number; qty?: number; status?: string; tenant?: string;
  manager?: string | null; cashier?: string | null; price?: number; lineTotal?: number; completed?: boolean } = {}) {
  const { at = '2026-10-04T10:00:00Z', total = 10000, cost = 6000, qty = 1, status = 'completed',
    tenant = 'shop', manager = null, cashier = 'seller', price = Math.round(total / qty), lineTotal = total, completed = true } = opts
  await state.db.query('INSERT INTO sales VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, tenant, total, status, completed ? at : null, at, manager, cashier])
  await state.db.query('INSERT INTO sale_items VALUES ($1,$2,$1,$3,$4,$5,$6,$7,0)', [id, tenant, 'p', qty, price, lineTotal, cost])
}
async function refund(id = 'r', opts: { source?: string; amount?: number; qty?: number; at?: string; action?: string; status?: string; tenant?: string } = {}) {
  const { source = 's', amount = 10000, qty = 1, at = '2026-10-04T13:00:00Z', action = 'return_to_stock', status = 'completed', tenant = 'shop' } = opts
  await state.db.query('INSERT INTO returns VALUES ($1,$2,$3,$4,$5,$6,$7,$7)', [id, tenant, source, status, at, action, amount])
  await state.db.query('INSERT INTO return_items VALUES ($1,$2,$1,$3,$4,$5,$6)', [id, tenant, source, 'p', qty, amount])
}
const order = async (id = 'o', saleId: string | null = 's', manager = 'manager', tenant = 'shop') =>
  state.db.query('INSERT INTO customer_orders VALUES ($1,$2,$3,$4)', [id, tenant, saleId, manager])
const salary = async (type = 'salary', amount = 1000, workDate = '2026-10-04', createdAt = '2026-10-08T10:00:00Z', source = 'manual', worker = 'seller', tenant = 'shop') =>
  state.db.query('INSERT INTO salary_payments VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [tenant, worker, 'Збережене ім’я', type, amount, workDate, createdAt, source])
beforeAll(async () => {
  state.db = new PGlite()
  await state.db.exec(`CREATE SCHEMA auth;
    CREATE TABLE auth.users(id text PRIMARY KEY,raw_app_meta_data jsonb,raw_user_meta_data jsonb);
    CREATE TABLE sales(id text PRIMARY KEY,tenant_id text,total int,status text,completed_at timestamptz,created_at timestamptz,manager_id text,cashier_id text);
    CREATE TABLE sale_items(id text PRIMARY KEY,tenant_id text,sale_id text,product_id text,qty numeric,unit_price int,total int,cost_price int,core_deposit_amount int);
    CREATE TABLE customer_orders(id text PRIMARY KEY,tenant_id text,sale_id text,manager_id text);
    CREATE TABLE returns(id text PRIMARY KEY,tenant_id text,sale_id text,status text,created_at timestamptz,stock_action text,refund_kopecks int,refund_amount int);
    CREATE TABLE return_items(id text PRIMARY KEY,tenant_id text,return_id text,sale_item_id text,product_id text,quantity numeric,total_kopecks int);
    CREATE TABLE salary_payments(tenant_id text,employee_id text,employee_name text,type text,amount int,work_date date,created_at timestamptz,source text);
  `)
}, 30000)
afterAll(async () => state.db?.close())
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T10:00:00Z'))
  await state.db.exec('TRUNCATE auth.users,sales,sale_items,customer_orders,returns,return_items,salary_payments')
  state.calls = 0; state.fail = false
})
afterEach(() => vi.useRealTimers())

it('keeps both staff routes restricted to owner/admin', () => {
  for (const name of Object.keys(handlers)) expect((router as any).stack.find((l: any) => l.route?.path === '/' + name).route.stack).toHaveLength(2)
  expect(state.roles.filter(roles => roles.join() === 'owner,admin').length).toBeGreaterThanOrEqual(4)
})
it('uses receipt cost and retains employees even without a current auth card', async () => {
  await sale()
  expect(await report()).toEqual([expect.objectContaining({ manager_id: 'seller', total_revenue: 10000, total_cogs: 6000, gross_profit: 4000 })])
  expect(state.calls).toBe(1)
})
it('keeps archived staff names and financial records', async () => {
  await employee('seller', 'shop', true); await sale()

  await salary()
  expect((await report())[0]).toMatchObject({ manager_name: 'Працівник seller', salary_cost: 1000, net_profit: 3000 })
})
it('keeps owner turnover without reviving legacy owner salary debt', async () => {
  await employee('seller'); await sale(); await salary()
  await state.db.exec(`UPDATE auth.users SET raw_app_meta_data=raw_app_meta_data||'{"role":"owner"}'::jsonb`)
  expect((await report())[0]).toMatchObject({ total_revenue: 10000, salary_cost: 0, total_payouts: 0, net_profit: 4000 })
  expect((await state.db.query('SELECT COUNT(*)::int n FROM salary_payments')).rows[0].n).toBe(1)
})
it('counts settled orders once and ignores unpaid/unissued orders', async () => {
  await employee('manager'); await sale(); await order(); await order('unissued', null)
  const row = (await report()).find(row => row.manager_id === 'manager')
  expect(row).toMatchObject({ sales_revenue: 0, orders_revenue: 10000, orders_cogs: 6000, total_revenue: 10000, gross_profit: 4000 })
})
it('keeps the seller captured in the receipt after the order manager changes', async () => {
  await sale('s', { manager: 'original' }); await order('o', 's', 'replacement')
  expect((await report())[0]).toMatchObject({ manager_id: 'original', orders_revenue: 10000 })
  await refund()
  expect((await report('staff-kpi'))[0]).toMatchObject({ manager_id: 'original', total_revenue: 10000, returns_amount: 10000 })
})
it('assigns each refund to its original seller, not every seller', async () => {
  await sale('s'); await sale('s2', { manager: 'second' }); await refund()
  const rows = await report('staff-kpi')
  expect(rows.find(row => row.manager_id === 'seller')).toMatchObject({ returns_count: 1, returns_amount: 10000 })
  expect(rows.find(row => row.manager_id === 'second')).toMatchObject({ returns_count: 0, returns_amount: 0 })
})
it.each(['return_to_stock', 'write_off', 'send_to_supplier'])('places a later %s refund on its own date', async action => {
  await sale('s', { at: '2026-10-03T10:00:00Z', status: 'returned' }); await refund('r', { action })
  expect((await report())[0]).toMatchObject({ total_revenue: -10000, total_cogs: action === 'return_to_stock' ? -6000 : 0,
    gross_profit: action === 'return_to_stock' ? -4000 : -10000 })
  expect((await report('staff-kpi'))[0]).toMatchObject({ receipt_count: 0, returns_count: 1, average_receipt: 0, returns_amount: 10000 })
})
it('includes fully returned receipts and subtracts same-day refunds once', async () => {
  await sale('s', { status: 'returned' }); await refund()
  expect((await report())[0]).toMatchObject({ total_revenue: 0, total_cogs: 0, gross_profit: 0 })
  expect((await report('staff-kpi'))[0]).toMatchObject({ total_revenue: 10000, receipt_count: 1, average_receipt: 10000, returns_count: 1 })
})
it('ignores uncompleted receipts and uncompleted/out-of-period returns', async () => {
  await sale(); await sale('draft', { status: 'draft' }); await sale('canceled', { status: 'cancelled' })
  await refund('draft-return', { status: 'draft' }); await refund('tomorrow', { at: '2026-10-05T10:00:00Z' })
  expect((await report('staff-kpi'))[0]).toMatchObject({ total_revenue: 10000, receipt_count: 1, returns_count: 0 })
})
it('isolates staff, receipts, orders, lines, refunds and salary by tenant', async () => {
  await employee('seller', 'other'); await sale(); await order('foreign-order', 's', 'foreign', 'other')
  await salary('salary', 1000, '2026-10-04', undefined, 'manual', 'seller', 'other')
  await refund('foreign-return', { tenant: 'other' }); await sale('foreign', { tenant: 'other' })
  await state.db.exec(`INSERT INTO sale_items VALUES ('other-line','other','s','p',100,10000,1000000,6000,0)`)
  expect(await report()).toEqual([expect.objectContaining({ manager_id: 'seller', manager_name: 'Невідомий працівник', sales_revenue: 10000, salary_cost: 0 })])
})
it.each([
  ['2026-10-03T20:59:59.999Z', 0], ['2026-10-03T21:00:00Z', 1],
  ['2026-10-04T20:59:59.999Z', 1], ['2026-10-04T21:00:00Z', 0],
])('uses Kyiv calendar boundaries: %s', async (at, count) => {
  await sale('s', { at })
  expect((await report('staff-kpi')).reduce((sum, row) => sum + row.receipt_count, 0)).toBe(count)
})
it('handles a 25-hour Kyiv daylight-saving day', async () => {
  await sale('s', { at: '2026-10-24T21:00:00Z' })
  await sale('late', { at: '2026-10-25T21:59:59Z' })
  await sale('tomorrow', { at: '2026-10-25T22:00:00Z' })
  const rows = await report('staff-kpi', { startDate: '2026-10-25', endDate: '2026-10-25' })
  expect(rows[0]).toMatchObject({ receipt_count: 2, total_revenue: 20000 })
})
it('supports legacy missing completed_at by its saved creation timestamp', async () => {
  await sale('s', { completed: false })
  expect((await report())[0].total_revenue).toBe(10000)
})
it('counts both line and receipt discounts against the pre-discount amount', async () => {
  await sale('s', { total: 16000, qty: 2, price: 10000, lineTotal: 18000 })
  expect((await report('staff-kpi'))[0]).toMatchObject({ total_revenue: 16000, total_discounts: 4000, discount_pct: 20, average_receipt: 16000 })
})
it('does not count a core deposit as a discount or revenue twice', async () => {
  await sale('s', { total: 10000, price: 10000, lineTotal: 11000 })
  await state.db.exec('UPDATE sale_items SET core_deposit_amount=1000')
  expect((await report('staff-kpi'))[0]).toMatchObject({ total_discounts: 1000, discount_pct: 9 })
})
it('counts recorded services/free-price lines without requiring product cards', async () => {
  await sale('s', { cost: 0 }); await state.db.exec('UPDATE sale_items SET product_id=NULL')
  expect((await report())[0]).toMatchObject({ total_cogs: 0, gross_profit: 10000 })
})
it('rounds fractional cost once per employee and keeps component totals consistent', async () => {
  await sale('s', { qty: .4, cost: 1, total: 4, price: 10 }); await order('o', 's', 'seller')
  await sale('s2', { qty: .4, cost: 1, total: 4, price: 10 })
  expect((await report())[0]).toMatchObject({ total_cogs: 1, sales_cogs: 0, orders_cogs: 1, total_revenue: 8, gross_profit: 7 })
})
it('uses work_date for accruals and payouts without deducting payouts twice', async () => {
  await sale(); await salary(); await salary('bonus', 200); await salary('penalty', 50); await salary('advance', 900)
  await salary('bonus', -100, '2026-10-04', undefined, 'commission_reversal')
  expect((await report())[0]).toMatchObject({ salary_cost: 1000, bonus_cost: 100, penalty_cost: 50, total_payouts: 900, net_profit: 2950 })
})
it('uses the saved employee name when the auth card is absent', async () => {
  await salary()
  expect((await report())[0]).toMatchObject({ manager_id: 'seller', manager_name: 'Збережене ім’я', net_profit: -1000 })
})
it('does not replace receipt history with another shop name from a salary fallback', async () => {
  await employee('seller', 'other'); await sale()
  expect((await report())[0].manager_name).toBe('Невідомий працівник')
})
it('never silently truncates more than 1000 receipts', async () => {
  await state.db.exec(`INSERT INTO sales SELECT 's'||g,'shop',100,'completed','2026-10-04T10:00:00Z','2026-10-04T10:00:00Z',NULL,'seller' FROM generate_series(1,1005) g;
    INSERT INTO sale_items SELECT id,'shop',id,'p',1,100,100,60,0 FROM sales;`)
  expect((await report('staff-kpi'))[0]).toMatchObject({ receipt_count: 1005, total_revenue: 100500 })
  expect(state.calls).toBe(1)
})
it.each([
  ['no items', 'DELETE FROM sale_items'],
  ['missing historical cost', 'UPDATE sale_items SET cost_price=NULL'],
  ['negative cost', 'UPDATE sale_items SET cost_price=-1'],
  ['invalid quantity', 'UPDATE sale_items SET qty=0'],
  ['incomplete receipt', 'UPDATE sale_items SET total=1'],
  ['missing source line', 'DELETE FROM sale_items'],
  ['wrong product identity', "UPDATE return_items SET product_id='other'"],
  ['return amount mismatch', 'UPDATE return_items SET total_kopecks=9999'],
  ['missing source receipt', 'DELETE FROM sales'],
])('rejects %s instead of presenting plausible partial results', async (_name, sql) => {
  await sale(); await refund(); await state.db.exec(sql)
  await expect(report()).rejects.toMatchObject({ code: 'INCOMPLETE_REPORT' })
})
it('rejects one receipt linked to two orders rather than multiplying it', async () => {
  await sale(); await order(); await order('second')
  await expect(report()).rejects.toMatchObject({ code: 'INCOMPLETE_REPORT' })
})
it('rejects a negative non-reversal salary', async () => {
  await salary('salary', -1)
  await expect(report()).rejects.toMatchObject({ code: 'INCOMPLETE_REPORT' })
})
it('the PostgreSQL amount column rejects fractional kopecks before reporting', async () => {
  await expect(salary('salary', .5)).rejects.toThrow('integer')
})
it.each([
  { startDate: '2026-02-30', endDate: '2026-10-04' },
  { startDate: '2026-10-05', endDate: '2026-10-04' },
  { startDate: ['2026-10-04'], endDate: '2026-10-04' },
  { startDate: '', endDate: '' },
])('rejects invalid ranges before reading the database: %j', async query => {
  await expect(report('staff-profitability', query)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  expect(state.calls).toBe(0)
})
it('defaults to the current Kyiv month and returns empty data only for a truly empty report', async () => {
  await sale('last-month', { at: '2026-09-30T20:59:59Z' })
  expect(await report('staff-profitability', {})).toEqual([])
})
it('propagates database failure instead of zero profit', async () => {
  state.fail = true
  await expect(report()).rejects.toThrow('database unavailable')
})
it('is strictly read-only when reporting twice', async () => {
  await sale(); await salary()
  const before = await state.db.query('SELECT * FROM salary_payments')
  const first = await report(); expect(await report()).toEqual(first)
  expect((await state.db.query('SELECT * FROM salary_payments')).rows).toEqual(before.rows)
})
