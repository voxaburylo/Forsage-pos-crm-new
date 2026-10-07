import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('../../db/pg.js', () => ({ pool: {}, runTransaction: (fn: any) => state.db.transaction((tx: any) => fn({
  query: async (sql: string, args: any[]) => {
    const result = await tx.query(sql, args)
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }
  },
})) }))
vi.mock('../../db/supabaseAdmin.js', () => ({ supabaseAdmin: {} }))
vi.mock('../../db/supabase.js', () => ({ db: {} }))
import { applySalaryPaymentCreated, applySalaryPaymentDeleted } from '../sync/staffHandlers.js'
import { applyCashOperationCreated } from '../sync/salesHandlers.js'

const tenant = randomUUID(), foreignTenant = randomUUID(), employee = randomUUID(), actor = randomUUID(), shift = randomUUID()
const created = '2026-10-01T09:00:00.000Z', removed = '2026-10-01T10:00:00.000Z'
const query = async (sql: string, args: any[] = []) => (await state.db.query(sql, args)).rows as any[]
function envelope(type: string, id: string, payload: any): any {
  return { sequence: 1, operation_id: randomUUID(), aggregate_id: id, aggregate_type: type.split('.')[0],
    operation_type: type, tenant_id: tenant, device_id: 'test', created_at: created,
    applied_at: '2026-10-04T10:00:00.000Z', payload }
}
function fixture(cash = true) {
  const id = randomUUID(), cashId = cash ? randomUUID() : null
  const payment = { id, employee_id: employee, employee_name: 'Працівник', amount: 12000,
    type: cash ? 'advance' : 'bonus', method: cash ? 'cash' : 'transfer', period: '2026-10',
    work_date: '2026-10-01', source: 'manual', note: 'Запис магазину', shift_id: cash ? shift : null,
    cash_operation_id: cashId, commission_source_sale_id: null, commission_source_order_id: null,
    commission_source_return_id: null, created_by: actor, created_at: created }
  return {
    id, cashId, payment,
    salary: envelope('salary_payment.created', id, { ...payment }),
    cash: envelope('cash_operation.created', cashId ?? randomUUID(), {
      id: cashId, shift_id: shift, type: 'out', amount: 12000, note: 'Виплата зарплати',
      source: 'cashbox', user_id: actor, employee_id: employee, work_date: '2026-10-01', created_at: created,
    }),
    deletion: { ...envelope('salary_payment.deleted', id, { id, deleted_payment: { ...payment } }), created_at: removed },
  }
}
const salary = (op: any) => applySalaryPaymentCreated(tenant, actor, op)
const cash = (op: any) => applyCashOperationCreated(tenant, actor, op)
const remove = (op: any) => applySalaryPaymentDeleted(tenant, op)
beforeEach(async () => {
  state.db = new PGlite()
  await state.db.exec(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_app_meta_data jsonb);
    CREATE TABLE shifts(id uuid PRIMARY KEY,tenant_id uuid,status text,opening_cash integer);
    CREATE TABLE sales(id uuid PRIMARY KEY,tenant_id uuid,status text);
    CREATE TABLE customer_orders(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid);
    CREATE TABLE returns(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid,status text);
    CREATE TABLE cash_operations(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,shift_id uuid NOT NULL REFERENCES shifts,
      type text NOT NULL CHECK(type IN ('in','out')),amount integer NOT NULL CHECK(amount>0),note text,source text,
      created_by uuid NOT NULL,employee_id uuid,work_date date,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
    CREATE TABLE salary_payments(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,employee_id uuid NOT NULL,
      employee_name text NOT NULL,amount integer NOT NULL,type text NOT NULL,method text NOT NULL,period varchar(7),
      work_date date NOT NULL,source varchar(30) NOT NULL,note text,cash_operation_id uuid REFERENCES cash_operations ON DELETE SET NULL,
      commission_source_sale_id uuid,commission_source_order_id uuid,commission_source_return_id uuid,
      created_by uuid,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
    CREATE TABLE sync_deletions(tenant_id uuid NOT NULL,entity_type text NOT NULL,entity_id uuid NOT NULL,
      deleted_at timestamptz NOT NULL,PRIMARY KEY(tenant_id,entity_type,entity_id));
    INSERT INTO auth.users VALUES('${employee}','{"tenant_id":"${tenant}","role":"manager"}'),
      ('${actor}','{"tenant_id":"${tenant}","role":"owner"}');
    INSERT INTO shifts VALUES('${shift}','${tenant}','closed',50000);
  `)
})
afterEach(async () => { await state.db.close() })

describe('financial copies remain deleted despite delayed delivery', () => {
  it('deletion before both creates suppresses salary and cash, including repeated delivery', async () => {
    const f = fixture()
    await remove(f.deletion)
    await cash(f.cash); await salary(f.salary); await cash(f.cash)
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(0)
    expect(await query('SELECT * FROM cash_operations')).toHaveLength(0)
    expect(await query('SELECT * FROM sync_deletions')).toHaveLength(2)
  })
  it('does not resurrect a deleted non-cash manual bonus', async () => {
    const f = fixture(false)
    await salary(f.salary); await remove(f.deletion); await salary(f.salary)
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(0)
  })
  it('does not resurrect the cash row after a normal create/delete sequence', async () => {
    const f = fixture()
    await cash(f.cash); await salary(f.salary); await remove(f.deletion); await cash(f.cash)
    expect(await query('SELECT * FROM cash_operations')).toHaveLength(0)
  })
  it('keeps an unknown legacy ID-only deletion pending, instead of falsely acknowledging it', async () => {
    const f = fixture(); f.deletion.payload = { id: f.id }
    await expect(remove(f.deletion)).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_REQUIRED' })
    expect(await query('SELECT * FROM sync_deletions')).toHaveLength(0)
  })
  it('reports a conflicting cash amount on retry', async () => {
    const f = fixture(); await cash(f.cash); f.cash.payload.amount += 1
    await expect(cash(f.cash)).rejects.toMatchObject({ code: 'SYNC_CASH_COPY_CONFLICT' })
    expect((await query('SELECT amount FROM cash_operations'))[0].amount).toBe(12000)
  })
  it('rejects fractional kopecks instead of silently rounding cash', async () => {
    const f = fixture(); f.cash.payload.amount = 12000.3
    await expect(cash(f.cash)).rejects.toMatchObject({ code: 'SYNC_CASH_OPERATION_INVALID' })
    expect(await query('SELECT * FROM cash_operations')).toHaveLength(0)
  })
})

describe('deletion ordering and atomicity', () => {
  it.each(['CSD', 'CDS', 'SCD', 'SDC', 'DCS', 'DSC'])('converges after delivery order %s and retries', async order => {
    const f = fixture()
    const actions: Record<string, () => Promise<void>> = {
      C: () => cash(f.cash), S: () => salary(f.salary), D: () => remove(f.deletion),
    }
    for (const key of order) {
      try { await actions[key]() } catch (error) {
        expect(key).toBe('S')
        expect(error).toMatchObject({ code: 'SYNC_SALARY_COPY_REQUIRED' })
      }
    }
    for (const key of 'CSDCSD') await actions[key]()
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(0)
    expect(await query('SELECT * FROM cash_operations')).toHaveLength(0)
    expect(await query('SELECT * FROM sync_deletions')).toHaveLength(2)
    expect((await query('SELECT opening_cash,status FROM shifts'))[0]).toEqual({ opening_cash: 50000, status: 'closed' })
  })
  it('processes an old ID-only delete after its source arrives and accepts repeated deletion', async () => {
    const f = fixture(); f.deletion.payload = { id: f.id }
    await expect(remove(f.deletion)).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_REQUIRED' })
    await cash(f.cash); await salary(f.salary); await remove(f.deletion)
    const before = await query('SELECT * FROM sync_deletions ORDER BY entity_type')
    await remove(f.deletion); await salary(f.salary); await cash(f.cash)
    expect(await query('SELECT * FROM sync_deletions ORDER BY entity_type')).toEqual(before)
    expect(await query('SELECT * FROM cash_operations')).toHaveLength(0)
  })
  it('does not need missing parent copies to delete a known local manual payment', async () => {
    const f = fixture()
    await query('DELETE FROM shifts'); await query('DELETE FROM auth.users')
    await remove(f.deletion); await cash(f.cash); await salary(f.salary)
    expect(await query('SELECT * FROM sync_deletions')).toHaveLength(2)
  })
  it('retains both documents if recording the deletion fails', async () => {
    const f = fixture(); await cash(f.cash); await salary(f.salary)
    const before = await query('SELECT * FROM cash_operations')
    await state.db.exec(`CREATE FUNCTION reject_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected write failure'; END $$;
      CREATE TRIGGER reject_tombstone BEFORE INSERT ON sync_deletions FOR EACH ROW EXECUTE FUNCTION reject_tombstone();`)
    await expect(remove(f.deletion)).rejects.toThrow('injected write failure')
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(1)
    expect(await query('SELECT * FROM cash_operations')).toEqual(before)
    expect(await query('SELECT * FROM sync_deletions')).toHaveLength(0)
  })
  it('does not erase owner cash contributions together with a canceled payout', async () => {
    const f = fixture(), contribution = fixture().cash
    contribution.payload.type = 'in'; contribution.payload.source = 'owner_funds'
    await cash(contribution); await cash(f.cash); await salary(f.salary); await remove(f.deletion)
    expect((await query('SELECT id,type,amount,source FROM cash_operations'))).toEqual([
      { id: contribution.aggregate_id, type: 'in', amount: 12000, source: 'owner_funds' },
    ])
  })
  it('does not let a repeated delete payload erase a different cash operation', async () => {
    const f = fixture(), other = fixture()
    await cash(f.cash); await salary(f.salary); await remove(f.deletion)
    await cash(other.cash)
    f.deletion.payload.deleted_payment.cash_operation_id = other.cashId
    await remove(f.deletion)
    expect((await query('SELECT id FROM cash_operations'))).toEqual([{ id: other.cashId }])
  })
  it.each(['commission', 'commission_reversal', 'daily_rate', 'daily_payout'])('does not delete an automatic stored %s record', async source => {
    const f = fixture(false); await salary(f.salary)
    await query('UPDATE salary_payments SET source=$1', [source]); f.deletion.payload = { id: f.id }
    await expect(remove(f.deletion)).rejects.toMatchObject({ code: 'SYNC_AUTOMATIC_SALARY_IMMUTABLE' })
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(1)
    expect(await query('SELECT * FROM sync_deletions')).toHaveLength(0)
  })
  it('does not issue a deletion tombstone for a valid automatic snapshot', async () => {
    const f = fixture(false)
    f.deletion.payload.deleted_payment.source = 'daily_rate'; f.deletion.payload.deleted_payment.type = 'salary'
    await expect(remove(f.deletion)).rejects.toMatchObject({ code: 'SYNC_AUTOMATIC_SALARY_IMMUTABLE' })
    expect(await query('SELECT * FROM sync_deletions')).toHaveLength(0)
  })
  it('rejects an automatic create under a previously manually deleted identity', async () => {
    const f = fixture(false); await remove(f.deletion)
    f.salary.payload.source = 'daily_rate'; f.salary.payload.type = 'salary'
    await expect(salary(f.salary)).rejects.toMatchObject({ code: 'SYNC_AUTOMATIC_SALARY_IMMUTABLE' })
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(0)
  })
  it.each(['amount', 'employee_name', 'work_date', 'cash_operation_id'])('does not delete a conflicting snapshot: %s', async field => {
    const f = fixture(); await cash(f.cash); await salary(f.salary)
    const changes: any = { amount: 11999, employee_name: 'Інший', work_date: '2026-10-02', cash_operation_id: randomUUID() }
    f.deletion.payload.deleted_payment[field] = changes[field]
    await expect(remove(f.deletion)).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_CONFLICT' })
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(1)
    expect(await query('SELECT * FROM cash_operations')).toHaveLength(1)
  })
  it('does not remove a movement used by another payroll row', async () => {
    const f = fixture(), other = fixture()
    await cash(f.cash); other.salary.payload.cash_operation_id = f.cashId; await salary(other.salary)
    await expect(remove(f.deletion)).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_CONFLICT' })
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(1)
    expect(await query('SELECT * FROM cash_operations')).toHaveLength(1)
  })
  it.each(['amount', 'type', 'shift_id', 'employee_id', 'work_date', 'created_by', 'created_at', 'tenant_id'])
  ('does not remove an unrelated/mismatching cash copy: %s', async field => {
    const f = fixture(); await cash(f.cash)
    const otherShift = randomUUID()
    await query('INSERT INTO shifts VALUES($1,$2,$3,0)', [otherShift, tenant, 'closed'])
    const change: any = { amount: 11999, type: 'in', shift_id: otherShift, employee_id: randomUUID(),
      work_date: '2026-10-02', created_by: randomUUID(), created_at: removed, tenant_id: foreignTenant }
    await query('UPDATE cash_operations SET ' + field + '=$1', [change[field]])
    await expect(remove(f.deletion)).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_CONFLICT' })
    expect(await query('SELECT * FROM sync_deletions')).toHaveLength(0)
    expect(await query('SELECT * FROM cash_operations')).toHaveLength(1)
  })
  it('rejects deletion of another tenant salary identity', async () => {
    const f = fixture(false); await salary(f.salary); await query('UPDATE salary_payments SET tenant_id=$1', [foreignTenant])
    await expect(remove(f.deletion)).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_CONFLICT' })
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(1)
  })
  it('ignores another tenant tombstone while preserving its record', async () => {
    const f = fixture(false)
    await query("INSERT INTO sync_deletions VALUES($1,'salary_payment',$2,$3)", [foreignTenant, f.id, removed])
    await salary(f.salary)
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(1)
    expect(await query('SELECT * FROM sync_deletions')).toHaveLength(1)
  })
  it.each(['foreign_tenant', 'payload_id', 'snapshot_id', 'missing_creation_time', 'null_snapshot'])('rejects invalid deletion %s', async mode => {
    const f = fixture()
    if (mode === 'foreign_tenant') f.deletion.tenant_id = foreignTenant
    if (mode === 'payload_id') f.deletion.payload.id = randomUUID()
    if (mode === 'snapshot_id') f.deletion.payload.deleted_payment.id = randomUUID()
    if (mode === 'missing_creation_time') delete f.deletion.payload.deleted_payment.created_at
    if (mode === 'null_snapshot') f.deletion.payload.deleted_payment = null
    await expect(remove(f.deletion)).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_INVALID' })
    expect(await query('SELECT * FROM sync_deletions')).toHaveLength(0)
  })
  it('rejects a late salary create that substitutes another cash identity after deletion', async () => {
    const f = fixture(); await remove(f.deletion)
    f.salary.payload.cash_operation_id = randomUUID()
    await expect(salary(f.salary)).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_CONFLICT' })
    expect(await query('SELECT * FROM salary_payments')).toHaveLength(0)
  })
  it('refuses to bind a new salary to an already deleted cash movement', async () => {
    const f = fixture()
    await query("INSERT INTO sync_deletions VALUES($1,'cash_operation',$2,$3)", [tenant, f.cashId, removed])
    await expect(salary(f.salary)).rejects.toMatchObject({ code: 'SYNC_SALARY_COPY_CONFLICT' })
  })
})

describe('cash copy validation and retry consistency', () => {
  it('leaves exact retries unchanged and validates historical closed-shift copies', async () => {
    const f = fixture(); await cash(f.cash)
    const before = await query('SELECT * FROM cash_operations')
    f.cash.applied_at = '2026-10-05T11:00:00.000Z'
    await cash(f.cash); await cash(f.cash)
    expect(await query('SELECT * FROM cash_operations')).toEqual(before)
  })
  it.each(['in', 'out', 'cash_in', 'cash_out', 'salary_payout', 'supplier_payment'])('normalizes supported legacy type %s explicitly', async type => {
    const f = fixture(); f.cash.payload.type = type; await cash(f.cash)
    expect((await query('SELECT type FROM cash_operations'))[0].type).toBe(['in', 'cash_in'].includes(type) ? 'in' : 'out')
  })
  it.each([
    { amount: 0 }, { amount: -1 }, { amount: NaN }, { amount: Infinity }, { amount: '12000' }, { amount: 2147483648 },
    { type: 'typo' }, { shift_id: null }, { shift_id: 'bad' }, { user_id: 'bad' }, { employee_id: 'bad' },
    { work_date: '2026-02-30' }, { created_at: 'bad' }, { source: 'typo' }, { id: randomUUID() },
    { user_id: 42, created_by: actor },
  ])('rejects invalid cash data %j', async patch => {
    const f = fixture(); Object.assign(f.cash.payload, patch)
    await expect(cash(f.cash)).rejects.toMatchObject({ code: 'SYNC_CASH_OPERATION_INVALID' })
    expect(await query('SELECT * FROM cash_operations')).toHaveLength(0)
  })
  it.each(['note', 'source', 'user_id', 'employee_id', 'work_date', 'created_at', 'shift_id', 'type'])
  ('detects immutable cash retry difference: %s', async field => {
    const f = fixture(); await cash(f.cash)
    const changes: any = { note: 'Інше', source: 'owner_funds', user_id: randomUUID(), employee_id: null,
      work_date: '2026-10-02', created_at: removed, shift_id: randomUUID(), type: 'in' }
    f.cash.payload[field] = changes[field]
    await expect(cash(f.cash)).rejects.toMatchObject({ code: 'SYNC_CASH_COPY_CONFLICT' })
    expect(await query('SELECT * FROM cash_operations')).toHaveLength(1)
  })
  it.each(['shift', 'actor', 'employee'])('requires the correct-tenant %s before acknowledging a new cash copy', async mode => {
    const f = fixture()
    if (mode === 'shift') await query('UPDATE shifts SET tenant_id=$1', [foreignTenant])
    else await query("UPDATE auth.users SET raw_app_meta_data=jsonb_build_object('tenant_id',$1::text) WHERE id=$2",
      [foreignTenant, mode === 'actor' ? actor : employee])
    await expect(cash(f.cash)).rejects.toMatchObject({ code: 'SYNC_CASH_COPY_REQUIRED' })
    expect(await query('SELECT * FROM cash_operations')).toHaveLength(0)
  })
  it('rejects a global cash ID collision across tenants', async () => {
    const f = fixture(); await cash(f.cash); await query('UPDATE cash_operations SET tenant_id=$1', [foreignTenant])
    await expect(cash(f.cash)).rejects.toMatchObject({ code: 'SYNC_CASH_COPY_CONFLICT' })
  })
})
