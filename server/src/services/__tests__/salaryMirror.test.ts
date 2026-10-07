import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('../../db/pg.js', () => ({ pool: {}, runTransaction: (fn: any) => state.db.transaction((tx: any) => fn({
  query: async (sql: string, args: any[]) => {
    const result = await tx.query(sql, args)
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }
  },
})) }))
vi.mock('../../db/supabaseAdmin.js', () => ({ supabaseAdmin: {} }))
vi.mock('../../db/supabase.js', () => ({ db: {} }))
import { applySalaryPaymentCreated } from '../sync/staffHandlers.js'

const tenant = randomUUID(), otherTenant = randomUUID(), employee = randomUUID(), actor = randomUUID()
const sale = randomUUID(), order = randomUUID(), returned = randomUUID(), shift = randomUUID()
const created = '2026-10-01T22:30:00.000Z'
const migrationUrl = new URL('../../../../supabase/migrations/20261004064324_salary_copy_reversal_identity.sql', import.meta.url)
const query = async (sql: string, args: any[] = []) => (await state.db.query(sql, args)).rows as any[]
function operation(overrides: Record<string, any> = {}): any {
  const id = randomUUID()
  return { sequence: 1, operation_id: randomUUID(), aggregate_id: id, aggregate_type: 'salary_payment',
    operation_type: 'salary_payment.created', tenant_id: tenant, device_id: 'test',
    created_at: created, applied_at: '2026-10-04T09:00:00.000Z',
    payload: { id, employee_id: employee, employee_name: 'Менеджер', amount: 1000,
      type: 'bonus', method: 'cash', period: '2026-10', work_date: '2026-10-02', source: 'commission',
      note: 'Локальна сума зі знижкою', shift_id: null, cash_operation_id: null,
      commission_source_sale_id: sale, commission_source_order_id: order, commission_source_return_id: null,
      created_by: actor, created_at: created, ...overrides } }
}
function reversal(overrides: Record<string, any> = {}) {
  return operation({ amount: -250, source: 'commission_reversal', commission_source_return_id: returned, ...overrides })
}
beforeEach(async () => {
  state.db = new PGlite()
  await state.db.exec(`
    CREATE SCHEMA auth;
    CREATE TABLE sync_deletions(tenant_id uuid,entity_type text,entity_id uuid,deleted_at timestamptz,
      PRIMARY KEY(tenant_id,entity_type,entity_id));
    CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_app_meta_data jsonb);
    CREATE TABLE sales(id uuid PRIMARY KEY,tenant_id uuid,status text);
    CREATE TABLE customer_orders(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid);
    CREATE TABLE returns(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid,status text);
    CREATE TABLE shifts(id uuid PRIMARY KEY,tenant_id uuid,status text,opening_cash integer);
    CREATE TABLE cash_operations(id uuid PRIMARY KEY,tenant_id uuid,shift_id uuid,type text,amount integer,created_by uuid);
    CREATE TABLE salary_payments(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,employee_id uuid NOT NULL,
      employee_name text NOT NULL,amount integer NOT NULL,type text NOT NULL,method text NOT NULL,period varchar(7),
      work_date date NOT NULL,source varchar(30) NOT NULL,note text,cash_operation_id uuid REFERENCES cash_operations,
      commission_source_sale_id uuid,commission_source_order_id uuid,commission_source_return_id uuid REFERENCES returns,
      created_by uuid,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
      CONSTRAINT salary_payments_sale_employee_comm_key UNIQUE(commission_source_sale_id,employee_id),
      CONSTRAINT salary_payments_order_employee_comm_key UNIQUE(commission_source_order_id,employee_id),
      CHECK((source='commission_reversal' AND amount<0) OR (source<>'commission_reversal' AND amount>0)));
    CREATE UNIQUE INDEX uq_salary_return_commission ON salary_payments(tenant_id,employee_id,commission_source_return_id)
      WHERE commission_source_return_id IS NOT NULL AND source='commission_reversal';
    CREATE UNIQUE INDEX salary_daily_rate_once_idx ON salary_payments(tenant_id,employee_id,work_date) WHERE source='daily_rate';
    INSERT INTO auth.users VALUES('${employee}','{"tenant_id":"${tenant}","role":"manager","deleted_at":"2026-10-03"}'),
      ('${actor}','{"tenant_id":"${tenant}","role":"cashier"}');
    INSERT INTO sales VALUES('${sale}','${tenant}','returned');
    INSERT INTO customer_orders VALUES('${order}','${tenant}','${sale}');
    INSERT INTO returns VALUES('${returned}','${tenant}','${sale}','completed');
    INSERT INTO shifts VALUES('${shift}','${tenant}','closed',0);
  `)
})
afterEach(async () => { await state.db.close() })
const apply = (op: any) => applySalaryPaymentCreated(tenant, actor, op)
const migrate = () => state.db.exec(readFileSync(migrationUrl, 'utf8'))

describe('exact local salary copies', () => {
  it('copies original award and return reversal without silently discarding the latter', async () => {
    await migrate()
    const award = operation(), reversed = reversal()
    await apply(award); await apply(reversed)
    const rows = await query('SELECT amount,source FROM salary_payments ORDER BY amount')
    expect(rows).toEqual([{ amount: -250, source: 'commission_reversal' }, { amount: 1000, source: 'commission' }])
  })
  it('does not acknowledge a different amount under an existing identity', async () => {
    const op = operation(); await apply(op)
    op.payload.amount = 999
    await expect(apply(op)).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_CONFLICT' })
    expect((await query('SELECT amount FROM salary_payments'))[0].amount).toBe(1000)
  })
  it('rejects fractional kopecks instead of silently rounding them', async () => {
    await expect(apply(operation({ amount: 1000.4 }))).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_INVALID' })
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(0)
  })
  it('does not acknowledge a second identity for the same original award', async () => {
    await apply(operation())
    await expect(apply(operation())).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_CONFLICT' })
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(1)
  })
  it('rejects an employee from another store', async () => {
    await query("UPDATE auth.users SET raw_app_meta_data=jsonb_build_object('tenant_id',$1::text) WHERE id=$2", [otherTenant, employee])
    await expect(apply(operation())).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_REQUIRED' })
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(0)
  })
  it('requires the actual original return before accepting its reversal', async () => {
    await query('DELETE FROM returns')
    await expect(apply(reversal({ commission_source_return_id: null }))).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_INVALID' })
  })
  it('keeps a reversal pending on the old schema rather than acknowledging loss', async () => {
    await apply(operation())
    await expect(apply(reversal())).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_CONFLICT' })
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(1)
  })
})

describe('salary mirror regression matrix', () => {
  beforeEach(migrate)
  it('retries awards and reversals without adding a second ledger entry or changing dates', async () => {
    const award = operation(), reversed = reversal()
    for (let attempt = 0; attempt < 3; attempt++) { await apply(award); await apply(reversed) }
    const rows = await query('SELECT * FROM salary_payments ORDER BY amount')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ amount: -250, commission_source_sale_id: sale, commission_source_order_id: order,
      commission_source_return_id: returned, created_by: actor })
    expect(rows[0].work_date.toISOString().slice(0, 10)).toBe('2026-10-02')
    expect(rows[0].created_at.toISOString()).toBe(created)
    expect(rows[0].updated_at.toISOString()).toBe(award.applied_at)
  })
  it('allows separate partial returns for the same award, but rejects another identity for one return', async () => {
    const nextReturn = randomUUID()
    await query("INSERT INTO returns VALUES($1,$2,$3,'completed')", [nextReturn, tenant, sale])
    await apply(operation()); await apply(reversal())
    await apply(reversal({ amount: -125, commission_source_return_id: nextReturn }))
    await expect(apply(reversal())).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_CONFLICT' })
    expect((await query('SELECT SUM(amount) total FROM salary_payments'))[0].total).toBe(625)
  })
  it('preserves original award uniqueness after migration, including legacy manual source', async () => {
    await apply(operation({ source: 'manual' }))
    await expect(apply(operation())).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_CONFLICT' })
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(1)
  })
  it('keeps daily-rate uniqueness and allows manual entries on the same date', async () => {
    const data = { commission_source_sale_id: null, commission_source_order_id: null, type: 'salary', source: 'daily_rate' }
    await apply(operation(data))
    await expect(apply(operation(data))).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_CONFLICT' })
    await apply(operation({ ...data, source: 'manual' }))
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(2)
  })
  it.each(['salary', 'bonus', 'advance', 'penalty'])('copies manual %s by transfer without creating cash movement', async type => {
    await apply(operation({ source: 'manual', type, method: 'transfer', period: null,
      commission_source_sale_id: null, commission_source_order_id: null, created_by: null }))
    expect(await query('SELECT * FROM cash_operations')).toHaveLength(0)
    expect((await query('SELECT * FROM salary_payments'))[0]).toMatchObject({ amount: 1000, source: 'manual', type, created_by: null, period: null })
  })
  it('copies a historical payout in a closed empty shift, leaving its cash entry untouched', async () => {
    const cashId = randomUUID()
    await query("INSERT INTO cash_operations VALUES($1,$2,$3,'out',1000,$4)", [cashId, tenant, shift, actor])
    const cashBefore = await query('SELECT * FROM cash_operations')
    const op = operation({ source: 'daily_payout', type: 'advance', shift_id: shift, cash_operation_id: cashId,
      commission_source_sale_id: null, commission_source_order_id: null })
    await apply(op); await apply(op)
    expect(await query('SELECT * FROM cash_operations')).toEqual(cashBefore)
    expect(await query('SELECT * FROM shifts')).toEqual([{ id: shift, tenant_id: tenant, status: 'closed', opening_cash: 0 }])
    expect((await query('SELECT * FROM salary_payments'))[0].cash_operation_id).toBe(cashId)
  })
  it.each(['employee_name', 'work_date', 'note', 'created_by', 'created_at', 'method', 'period'])('detects changed immutable %s on retry', async field => {
    const op = operation(); await apply(op)
    const changes: Record<string, any> = { employee_name: 'Інше імʼя', work_date: '2026-10-03', note: 'Змінено',
      created_by: null, created_at: '2026-10-03T10:00:00Z', method: 'transfer', period: '2026-09' }
    op.payload[field] = changes[field]
    await expect(apply(op)).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_CONFLICT' })
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(1)
  })
  it('does not silently overwrite old copies missing commission provenance', async () => {
    const op = operation()
    await apply(op)
    await query('UPDATE salary_payments SET commission_source_sale_id=null,commission_source_order_id=null')
    await expect(apply(op)).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_CONFLICT' })
  })
  it('does not copy an ID used by another tenant', async () => {
    const op = operation(); await apply(op)
    await query('UPDATE salary_payments SET tenant_id=$1', [otherTenant])
    await expect(apply(op)).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_CONFLICT' })
  })
  it.each([
    { amount: 0 }, { amount: '1000' }, { amount: NaN }, { amount: Infinity }, { amount: 2147483648 }, { amount: -1000 },
    { source: 'commission_reversal', amount: 1000 }, { source: 'other' }, { type: 'other' }, { method: 'other' },
    { type: 'advance' }, { work_date: '2026-02-30' }, { work_date: '2026-10-02T10:00Z' }, { period: '2026-13' },
    { commission_source_sale_id: 'bad-id' }, { commission_source_sale_id: null, commission_source_order_id: null },
    { commission_source_return_id: returned }, { created_at: 'not-a-date' }, { id: randomUUID() },
    { source: 'daily_rate', type: 'bonus' }, { source: 'daily_payout', type: 'salary' },
  ])('rejects invalid or inconsistent payroll fields %#', async data => {
    await expect(apply(operation(data))).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_INVALID' })
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(0)
  })
  it.each(['sales', 'customer_orders', 'returns'])('waits for a missing or foreign %s copy', async table => {
    await query(`UPDATE ${table} SET tenant_id=$1`, [otherTenant])
    await expect(apply(reversal())).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_REQUIRED' })
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(0)
  })
  it.each(['customer_orders', 'returns'])('rejects %s attached to another sale', async table => {
    await query(`UPDATE ${table} SET sale_id=$1`, [randomUUID()])
    await expect(apply(reversal())).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_REQUIRED' })
  })
  it('rejects a draft return and succeeds only once it is completed', async () => {
    const op = reversal()
    await query("UPDATE returns SET status='draft'")
    await expect(apply(op)).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_REQUIRED' })
    await query("UPDATE returns SET status='completed'")
    await apply(op); await apply(op)
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(1)
  })
  it('waits for a missing cash copy, then succeeds without paying it again', async () => {
    const cashId = randomUUID()
    const op = operation({ type: 'advance', source: 'manual', cash_operation_id: cashId, shift_id: shift,
      commission_source_sale_id: null, commission_source_order_id: null })
    await expect(apply(op)).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_REQUIRED' })
    await query("INSERT INTO cash_operations VALUES($1,$2,$3,'out',1000,$4)", [cashId, tenant, shift, actor])
    await apply(op); await apply(op)
    expect(await query('SELECT * FROM cash_operations')).toHaveLength(1)
  })
  it.each(['amount', 'type', 'shift_id', 'tenant_id'])('rejects a mismatched cash copy: %s', async field => {
    const cashId = randomUUID()
    await query("INSERT INTO cash_operations VALUES($1,$2,$3,'out',1000,$4)", [cashId, tenant, shift, actor])
    const changes: Record<string, any> = { amount: 1500, type: 'in', shift_id: randomUUID(), tenant_id: otherTenant }
    await query(`UPDATE cash_operations SET ${field}=$1`, [changes[field]])
    await expect(apply(operation({ type: 'advance', source: 'manual', cash_operation_id: cashId, shift_id: shift,
      commission_source_sale_id: null, commission_source_order_id: null }))).rejects.toMatchObject({
        code: field === 'tenant_id' ? 'SYNC_SALARY_COPY_REQUIRED' : 'SYNC_SALARY_COPY_CONFLICT',
      })
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(0)
  })
  it('rejects a foreign shift even for a non-cash payout', async () => {
    await query('UPDATE shifts SET tenant_id=$1', [otherTenant])
    await expect(apply(operation({ source: 'manual', type: 'advance', method: 'transfer', shift_id: shift })))
      .rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_REQUIRED' })
  })
  it('rejects an operation claiming another tenant before any write', async () => {
    const op = operation(); op.tenant_id = otherTenant
    await expect(apply(op)).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_INVALID' })
  })
  it('rolls back a failed insert and allows the exact retry afterwards', async () => {
    const op = operation()
    await state.db.exec("ALTER TABLE salary_payments ADD CONSTRAINT test_write_failure CHECK(amount<>1000)")
    await expect(apply(op)).rejects.toThrow()
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(0)
    await state.db.exec('ALTER TABLE salary_payments DROP CONSTRAINT test_write_failure')
    await apply(op)
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(1)
  })
  it('does not count the same cash payout under a second salary ID', async () => {
    const cashId = randomUUID()
    await query("INSERT INTO cash_operations VALUES($1,$2,$3,'out',1000,$4)", [cashId, tenant, shift, actor])
    const data = { source: 'manual', type: 'advance', cash_operation_id: cashId, shift_id: shift,
      commission_source_sale_id: null, commission_source_order_id: null }
    await apply(operation(data))
    await expect(apply(operation(data))).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_CONFLICT' })
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(1)
  })
  it('requires the original actor to belong to the same store', async () => {
    await query("UPDATE auth.users SET raw_app_meta_data=jsonb_build_object('tenant_id',$1::text) WHERE id=$2", [otherTenant, actor])
    await expect(apply(operation())).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_REQUIRED' })
  })
  it('keeps each employees award and reversal independently', async () => {
    await apply(operation()); await apply(reversal())
    await apply(operation({ employee_id: actor })); await apply(reversal({ employee_id: actor }))
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(4)
  })
  it('rejects pending receipts and does not substitute another receipt', async () => {
    await query("UPDATE sales SET status='draft'")
    await expect(apply(operation())).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_REQUIRED' })
  })
  it('allows an order-only legacy commission and validates return-only provenance', async () => {
    await apply(operation({ commission_source_sale_id: null }))
    await apply(reversal({ commission_source_sale_id: null }))
    const next = randomUUID()
    await query("INSERT INTO returns VALUES($1,$2,$3,'completed')", [next, tenant, sale])
    await apply(reversal({ commission_source_sale_id: null, commission_source_order_id: null, commission_source_return_id: next }))
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(3)
  })
  it('checks return/order agreement even without an explicit sale field', async () => {
    await query('UPDATE customer_orders SET sale_id=$1', [randomUUID()])
    await expect(apply(reversal({ commission_source_sale_id: null }))).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_REQUIRED' })
  })
  it('never trusts user-editable metadata for payroll identity', async () => {
    await state.db.exec('ALTER TABLE auth.users ADD COLUMN raw_user_meta_data jsonb')
    await query("UPDATE auth.users SET raw_app_meta_data='{}',raw_user_meta_data=jsonb_build_object('tenant_id',$1::text) WHERE id=$2", [tenant, employee])
    await expect(apply(operation())).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_REQUIRED' })
  })
  it('migration is repeatable and preserves all existing financial rows', async () => {
    await apply(operation())
    const before = await query('SELECT * FROM salary_payments')
    await migrate(); await migrate()
    expect(await query('SELECT * FROM salary_payments')).toEqual(before)
  })
})
