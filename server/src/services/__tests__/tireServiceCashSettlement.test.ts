import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, queries: [] as string[], workerDailyRate: 0 }))
const tenant = '11111111-1111-4111-8111-111111111111'
const worker = '22222222-2222-4222-8222-222222222222'
const onDutyWorker = '33333333-3333-4333-8333-333333333333'
const cashier = '44444444-4444-4444-8444-444444444444'
const shift = '55555555-5555-4555-8555-555555555555'
const operation = '66666666-6666-4666-8666-666666666666'
const date = '2026-09-23'

vi.mock('../../db/supabase.js', () => ({ db: {} }))
vi.mock('../../db/supabaseAdmin.js', () => ({ supabaseAdmin: {} }))
vi.mock('../../middleware/auth.js', () => ({ requireAuth: vi.fn(), requireRole: () => vi.fn() }))
vi.mock('../adminService.js', () => ({ listUsers: async () => [
  { id: '22222222-2222-4222-8222-222222222222', role: 'tire_worker', is_active: true, full_name: 'Actual worker', base_rate: state.workerDailyRate, rate_period: 'day' },
  { id: '33333333-3333-4333-8333-333333333333', role: 'tire_worker', is_active: true, full_name: 'On-duty worker', base_rate: 0, rate_period: 'day' },
  { id: '44444444-4444-4444-8444-444444444444', role: 'cashier', is_active: true, full_name: 'Cashier' },
] }))
vi.mock('../../db/pg.js', () => {
  const query = async (sql: string, params: unknown[] = []) => {
    state.queries.push(sql)
    const result = await state.db.query(sql, params)
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }
  }
  return { pool: { query }, runTransaction: async (fn: any) => state.db.transaction(async (tx: any) => fn({
    query: async (sql: string, params: unknown[] = []) => {
      state.queries.push(sql)
      const result = await tx.query(sql, params)
      return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }
    },
  })) }
})
import router from '../../routes/salary.js'

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
  state.db = new PGlite()
  state.queries = []
  state.workerDailyRate = 0
  await state.db.exec(`
    CREATE TABLE products(id text PRIMARY KEY, tenant_id uuid, name text, sku text);
    CREATE TABLE sales(id text PRIMARY KEY, tenant_id uuid, sale_number text, completed_at timestamptz,
      manager_id uuid, cashier_id uuid, shift_id uuid, payment_method text, total bigint, cash_amount bigint,
      notes text, status text, deleted_at timestamptz);
    CREATE TABLE sale_items(id text PRIMARY KEY, tenant_id uuid, sale_id text, product_id text, sku text,
      description text, qty numeric, unit_price bigint, total bigint, core_deposit_amount bigint DEFAULT 0, deleted_at timestamptz);
    CREATE TABLE salary_payments(id text PRIMARY KEY, tenant_id uuid, employee_id uuid, employee_name text,
      amount bigint, type text, source text, method text, note text, work_date date, created_at timestamptz,
      created_by uuid, commission_source_sale_id text, cash_operation_id uuid, deleted_at timestamptz);
    CREATE TABLE cash_operations(id uuid PRIMARY KEY, tenant_id uuid, shift_id uuid, type text, source text,
      amount bigint, employee_id uuid, work_date date, note text, created_by uuid, created_at timestamptz, deleted_at timestamptz);
    CREATE TABLE shifts(id uuid PRIMARY KEY, tenant_id uuid, status text);
  `)
  await state.db.query('INSERT INTO shifts VALUES ($1,$2,\'open\')', [shift, tenant])
  await state.db.query("INSERT INTO products VALUES ('service',$1,'Tire service','POS-TIRE-SERVICE'),('goods',$1,'Goods','GOODS')", [tenant])
})
afterEach(async () => { try { await state.db.close() } finally { vi.useRealTimers() } })

async function sale(options: { total?: number; cash?: number; method?: string; completedAt?: string; manager?: string } = {}) {
  await state.db.query(`INSERT INTO sales VALUES ('sale',$1,'TIRE-1',$2,$3,$4,$5,$6,$7,$8,
    'Overnight work entered next morning','completed',NULL)`, [tenant, options.completedAt ?? '2026-09-23T06:00:00Z',
    options.manager ?? worker, cashier, shift, options.method ?? 'cash', options.total ?? 36000, options.cash ?? 36000])
}
async function line(id: string, total: number, service = true, core = 0) {
  await state.db.query(`INSERT INTO sale_items(id,tenant_id,sale_id,product_id,sku,description,qty,unit_price,total,core_deposit_amount)
    VALUES ($1,$2,'sale',$3,$4,$5,1,$6,$6,$7)`, [id, tenant, service ? 'service' : 'goods',
    service ? 'POS-TIRE-SERVICE' : 'GOODS', service ? 'Tire work' : 'Goods', total, core])
}
async function request(path = '/tire-service-report', body: Record<string, unknown> = {}, requestTenant = tenant, reportDate = date) {
  const handler = (router as any).stack.find((layer: any) => layer.route?.path === path).route.stack.at(-1).handle
  const json = vi.fn(), next = vi.fn(), status = vi.fn()
  const response = { json, status }; status.mockReturnValue(response)
  await handler({ query: { date: reportDate }, body, user: { tenant_id: requestTenant, id: cashier } }, response, next)
  return { json, next, status }
}
const handover = () => ({ employee_id: worker, employee_name: 'Actual worker', work_date: date,
  shift_id: shift, amount: 36000, operation_id: operation })
async function snapshot() {
  return Promise.all(['sales', 'sale_items', 'salary_payments', 'cash_operations'].map(async table =>
    (await state.db.query(`SELECT * FROM ${table} ORDER BY id`)).rows))
}

it('counts next-day POS cash as already in the register and credits the actual worker, not the on-duty worker', async () => {
  await sale(); await line('tire', 36000)
  await state.db.query(`INSERT INTO salary_payments(id,tenant_id,employee_id,amount,type,source,work_date,commission_source_sale_id)
    VALUES ('commission',$1,$2,12600,'bonus','commission',$3,'sale')`, [tenant, worker, date])
  const before = await snapshot()
  const { json, next } = await request()
  expect(next).not.toHaveBeenCalled()
  const report = json.mock.calls[0][0]
  expect(report.receipts[0]).toMatchObject({ employee_id: worker, cashier_id: cashier, cash_revenue: 36000,
    cash_register_received: 36000, commission_earned: 12600, notes: 'Overnight work entered next morning' })
  expect(report.data.find((row: any) => row.employee_id === worker)).toMatchObject({
    cash_register_received: 36000, cash_handed_over: 0, cash_pending: 0, due: 12600, salary_ready: true, payable_due: 12600,
  })
  expect(report.data.find((row: any) => row.employee_id === onDutyWorker)).toMatchObject({
    service_revenue: 0, cash_register_received: 0, commission_earned: 0,
  })
  expect(report.totals).toMatchObject({ cash_register_received: 36000, cash_pending: 0 })
  expect(await snapshot()).toEqual(before)
})

it('retains the existing two-day payout delay without demanding cash from the worker', async () => {
  vi.setSystemTime(new Date('2026-09-24T12:00:00Z'))
  await sale(); await line('tire', 36000)
  const { json, next } = await request()
  expect(next).not.toHaveBeenCalled()
  expect(json.mock.calls[0][0].data[0]).toMatchObject({
    cash_pending: 0, salary_ready: false, salary_available_on: '2026-09-25', payable_due: 0,
  })
})

it.each([
  { name: 'receipt discount', total: 30000, cash: 30000, method: 'cash', tire: 36000, goods: 0, expected: 30000 },
  { name: 'mixed receipt discount', total: 54000, cash: 27000, method: 'mixed', tire: 36000, goods: 24000, expected: 16200 },
  { name: 'card only', total: 36000, cash: 0, method: 'card', tire: 36000, goods: 0, expected: 0 },
  { name: 'core deposit protection', total: 25000, cash: 25000, method: 'cash', tire: 10000, goods: 20000, core: 10000, expected: 7500 },
])('allocates cash across all receipt rows for $name without rewriting gross work values', async fixture => {
  await sale(fixture); await line('a-tire', fixture.tire)
  if (fixture.goods) await line('b-goods', fixture.goods, false, fixture.core ?? 0)
  const { json, next } = await request()
  expect(next).not.toHaveBeenCalled()
  const report = json.mock.calls[0][0]
  expect(report.receipts[0]).toMatchObject({ service_revenue: fixture.tire, cash_revenue: fixture.expected,
    cash_register_received: fixture.expected })
  expect(report.receipts[0].services).toHaveLength(1)
  expect(report.totals.cash_register_received).toBe(fixture.expected)
})

it('allocates the last kopeck deterministically before selecting service rows', async () => {
  await sale({ total: 2, cash: 1, method: 'mixed' })
  await line('a-goods', 1, false); await line('b-tire', 1)
  const { json, next } = await request()
  expect(next).not.toHaveBeenCalled()
  expect(json.mock.calls[0][0].receipts[0].cash_register_received).toBe(0)
})

it('keeps receipt allocation scoped to live rows of the requested tenant and Kyiv date', async () => {
  await sale(); await line('tire', 36000)
  await line('deleted-goods', 999999, false)
  await state.db.query("UPDATE sale_items SET deleted_at='2026-09-24' WHERE id='deleted-goods'")
  await line('foreign-goods', 999999, false)
  await state.db.query("UPDATE sale_items SET tenant_id=$1 WHERE id='foreign-goods'", [onDutyWorker])
  const { json, next } = await request()
  expect(next).not.toHaveBeenCalled()
  expect(json.mock.calls[0][0].receipts[0].cash_register_received).toBe(36000)
  await state.db.query("UPDATE sales SET completed_at='2026-09-22T20:30:00Z'")
  expect((await request()).json.mock.calls[0][0].receipts).toEqual([])
})

it('rejects a new handover without any financial write even when the old calculation says pending', async () => {
  await sale(); await line('tire', 36000)
  const before = await snapshot()
  const { json, next } = await request('/tire-cash-handover', handover())
  expect(json).not.toHaveBeenCalled()
  expect(next.mock.calls[0][0]).toMatchObject({ code: 'NOTHING_TO_HAND_OVER', status: 409 })
  expect(await snapshot()).toEqual(before)
  expect(state.queries.some(sql => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false)
})

it('preserves a historical exact handover replay and history without counting it as new POS receipt cash', async () => {
  await sale(); await line('tire', 36000)
  await state.db.query(`INSERT INTO cash_operations VALUES ($1,$2,$3,'in','cashbox',36000,$4,$5,'Historical',$6,'2026-09-24',NULL)`,
    [operation, tenant, shift, worker, date, cashier])
  await state.db.query("UPDATE shifts SET status='closed'")
  const before = await snapshot()
  const { json, next, status } = await request('/tire-cash-handover', handover())
  expect(next).not.toHaveBeenCalled(); expect(status).toHaveBeenCalledWith(200)
  expect(json).toHaveBeenCalledWith({ data: { amount: 36000, remaining: 0, created: false } })
  const report = (await request()).json.mock.calls[0][0]
  expect(report.data[0]).toMatchObject({ cash_register_received: 36000, cash_handed_over: 36000, cash_pending: 0 })
  expect(report.cash_handovers).toHaveLength(1)
  expect(await snapshot()).toEqual(before)
  expect(state.queries.some(sql => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false)
})

it('replays the legacy partial-handover remaining metadata without authorizing a new cash movement', async () => {
  await sale(); await line('tire', 36000)
  await state.db.query(`INSERT INTO cash_operations VALUES ($1,$2,$3,'in','cashbox',12000,$4,$5,'Historical',$6,'2026-09-24',NULL)`,
    [operation, tenant, shift, worker, date, cashier])
  const before = await snapshot()
  const { json, next } = await request('/tire-cash-handover', { ...handover(), amount: 12000 })
  expect(next).not.toHaveBeenCalled()
  expect(json).toHaveBeenCalledWith({ data: { amount: 12000, remaining: 24000, created: false } })
  expect((await request()).json.mock.calls[0][0].data[0].cash_pending).toBe(0)
  expect(await snapshot()).toEqual(before)
})

it.each(['amount', 'employee_id', 'shift_id', 'work_date', 'created_by', 'type', 'source', 'deleted_at'])(
  'rejects a reused handover id with changed %s without writes', async field => {
    await state.db.query(`INSERT INTO cash_operations VALUES ($1,$2,$3,'in','cashbox',36000,$4,$5,'Historical',$6,'2026-09-24',NULL)`,
      [operation, tenant, shift, worker, date, cashier])
    const mismatch: Record<string, unknown> = { amount: 1, employee_id: onDutyWorker, shift_id: operation,
      work_date: '2026-09-22', created_by: worker, type: 'out', source: 'owner_funds', deleted_at: '2026-09-25' }
    await state.db.query(`UPDATE cash_operations SET ${field}=$1`, [mismatch[field]])
    const before = await snapshot()
    const { json, next } = await request('/tire-cash-handover', handover())
    expect(json).not.toHaveBeenCalled()
    expect(next.mock.calls[0][0]).toMatchObject({ code: 'HANDOVER_OPERATION_CONFLICT', status: 409 })
    expect(await snapshot()).toEqual(before)
  },
)

it('does not replay or expose another tenant operation with the same id', async () => {
  await state.db.query(`INSERT INTO cash_operations VALUES ($1,$2,$3,'in','cashbox',36000,$4,$5,'Foreign',$6,'2026-09-24',NULL)`,
    [operation, onDutyWorker, shift, worker, date, cashier])
  const { json, next } = await request('/tire-cash-handover', handover())
  expect(json).not.toHaveBeenCalled()
  expect(next.mock.calls[0][0]).toMatchObject({ code: 'NOTHING_TO_HAND_OVER', status: 409 })
  expect(state.queries.every(sql => !/\b(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(true)
})

it('keeps the original gross receipt after the final return, with signed reversals on their own dates and read-only replay', async () => {
  await sale(); await line('tire', 36000)
  await state.db.query("UPDATE sale_items SET qty=2,unit_price=18000 WHERE id='tire'")
  await state.db.query(`INSERT INTO salary_payments(id,tenant_id,employee_id,amount,type,source,work_date,
    created_at,created_by,commission_source_sale_id) VALUES ('commission',$1,$2,12600,'bonus','commission',$3,
    '2026-09-23T06:00:00Z',$4,'sale')`, [tenant, worker, date, cashier])
  const read = async (reportDate: string) => {
    const { json, next } = await request('/tire-service-report', {}, tenant, reportDate)
    expect(next).not.toHaveBeenCalled()
    return json.mock.calls[0][0]
  }
  const original = await read(date)
  expect(original.receipts).toHaveLength(1)
  expect(original.receipts[0]).toMatchObject({ services_qty: 2, service_revenue: 36000,
    cash_revenue: 36000, cash_register_received: 36000, commission_earned: 12600 })

  // These are committed mirror snapshots, not calls to the refund writer.
  // A partial refund leaves the receipt completed; only the final one marks it returned.
  const committedRefund = async (id: string, refundDay: string, final: boolean) => {
    await state.db.query(`INSERT INTO salary_payments(id,tenant_id,employee_id,amount,type,source,work_date,
      created_at,created_by,commission_source_sale_id) VALUES ($1,$2,$3,-6300,'bonus','commission_reversal',$4,
      $5,$6,'sale')`, [id, tenant, worker, refundDay, `${refundDay}T07:00:00Z`, cashier])
    await state.db.query(`INSERT INTO cash_operations VALUES ($1,$2,$3,'out','cashbox',18000,NULL,NULL,
      'Committed refund',$4,$5,NULL)`, [final ? onDutyWorker : operation, tenant, shift, cashier, `${refundDay}T07:00:00Z`])
    if (final) await state.db.query("UPDATE sales SET status='returned' WHERE id='sale'")
  }
  await committedRefund('reversal-1', '2026-09-24', false)
  expect((await read(date)).receipts).toEqual(original.receipts)
  const partialDay = await read('2026-09-24')
  expect(partialDay.receipts).toEqual([])
  expect(partialDay.data.find((row: any) => row.employee_id === worker)).toMatchObject({
    commission_earned: -6300, earned: -6300, balance: -6300, due: 0, cash_register_received: 0,
  })
  await committedRefund('reversal-2', '2026-09-25', true)
  const committed = await snapshot()
  const byDate = [await read(date), await read('2026-09-24'), await read('2026-09-25')]
  expect(byDate[0].receipts).toEqual(original.receipts)
  expect(byDate[0].data.find((row: any) => row.employee_id === worker)).toMatchObject({
    services_qty: 2, service_revenue: 36000, cash_revenue: 36000, cash_register_received: 36000,
    commission_earned: 12600, earned: 12600, cash_pending: 0,
  })
  for (const [index, report] of byDate.slice(1).entries()) {
    expect(report.receipts).toEqual([])
    expect(report.totals).toMatchObject({ service_revenue: 0, cash_revenue: 0, cash_register_received: 0 })
    expect(report.salary_operations).toHaveLength(1)
    expect(report.salary_operations[0]).toMatchObject({ source: 'commission_reversal', amount: -6300,
      work_date: index === 0 ? '2026-09-24' : '2026-09-25', sale_id: 'sale', cashier_name: 'Cashier' })
    expect(report.data.find((row: any) => row.employee_id === worker).commission_earned).toBe(-6300)
  }
  expect([await read(date), await read('2026-09-24'), await read('2026-09-25')]).toEqual(byDate)
  expect(await snapshot()).toEqual(committed)
  expect(state.queries.every(sql => !/\b(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(true)
})

it.each(['draft', 'cancelled', 'foreign-sale', 'foreign-item', 'deleted-sale', 'deleted-item', 'unassigned-worker'])(
  'does not expose %s while reading original returned receipt history', async reason => {
    await sale(); await line('tire', 36000)
    await state.db.query("UPDATE sales SET status='returned'")
    if (reason === 'draft' || reason === 'cancelled') await state.db.query('UPDATE sales SET status=$1', [reason])
    if (reason === 'foreign-sale') await state.db.query('UPDATE sales SET tenant_id=$1', [onDutyWorker])
    if (reason === 'foreign-item') await state.db.query('UPDATE sale_items SET tenant_id=$1', [onDutyWorker])
    if (reason === 'deleted-sale') await state.db.query("UPDATE sales SET deleted_at='2026-09-25'")
    if (reason === 'deleted-item') await state.db.query("UPDATE sale_items SET deleted_at='2026-09-25'")
    if (reason === 'unassigned-worker') await state.db.query('UPDATE sales SET manager_id=NULL')
    const committed = await snapshot()
    const { json, next } = await request()
    expect(next).not.toHaveBeenCalled()
    expect(json.mock.calls[0][0].receipts).toEqual([])
    expect(json.mock.calls[0][0].totals).toMatchObject({ service_revenue: 0, cash_revenue: 0, cash_register_received: 0 })
    expect(await snapshot()).toEqual(committed)
    expect(state.queries.every(sql => !/\b(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(true)
  },
)

it('preserves an unrecorded daily-rate projection for the original work day after return without creating payroll rows', async () => {
  state.workerDailyRate = 5000
  await sale(); await line('tire', 36000)
  const initial = await request()
  expect(initial.next).not.toHaveBeenCalled()
  const expectedWorker = initial.json.mock.calls[0][0].data.find((row: any) => row.employee_id === worker)
  expect(expectedWorker).toMatchObject({ daily_rate: 5000, daily_rate_projected: 5000, earned: 5000 })
  await state.db.query("UPDATE sales SET status='returned' WHERE id='sale'")
  const committed = await snapshot()
  for (let read = 0; read < 2; read++) {
    const { json, next } = await request()
    expect(next).not.toHaveBeenCalled()
    expect(json.mock.calls[0][0].data.find((row: any) => row.employee_id === worker)).toEqual(expectedWorker)
    expect(json.mock.calls[0][0].salary_operations).toEqual([])
  }
  expect((await state.db.query('SELECT COUNT(*)::int AS count FROM salary_payments')).rows[0].count).toBe(0)
  expect(await snapshot()).toEqual(committed)
  expect(state.queries.every(sql => !/\b(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(true)
})
