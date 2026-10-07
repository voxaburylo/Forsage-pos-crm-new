import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalStaffRepository } from '../src/repositories/staffRepository'
import { attachBalanceSnapshots } from '../src/repositories/balanceSnapshot'

describe('salary copy provenance, including old undelivered operations', () => {
  let root: string, db: LocalDatabase, employee: string, actor: string, payment: any
  const sale = randomUUID(), order = randomUUID(), returned = randomUUID()
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-salary-copy-'))
    db = new LocalDatabase(root); employee = randomUUID(); actor = randomUUID()
    db.prepare(`INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at)
      VALUES(?,?,?,'manager',?,?)`).run(employee, tenant, 'Працівник', '2026-10-01', '2026-10-01')
    payment = new LocalStaffRepository(db).createSalary({ employee_id: employee, type: 'bonus', method: 'transfer',
      amount: 1250, user_id: actor, work_date: '2026-10-02', period: '2026-10' })
  })
  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-salary-copy-')) rmSync(root, { recursive: true, force: true })
  })
  function outgoing(): any {
    const row = db.prepare("SELECT * FROM sync_outbox WHERE operation_type='salary_payment.created' AND aggregate_id=?").get(payment.id) as any
    return { ...row, payload: JSON.parse(row.payload_json) }
  }
  function legacy(): any {
    const op = outgoing(), shift = randomUUID()
    db.prepare("INSERT INTO shifts(id,tenant_id,cashier_id,status,opened_at,created_at,updated_at) VALUES(?,?,?,'closed',?,?,?)")
      .run(shift, tenant, actor, '2026-10-01', '2026-10-01', '2026-10-01')
    db.prepare("INSERT INTO sales(id,tenant_id,sale_number,cashier_id,shift_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(sale, tenant, 'COPY-TEST', actor, shift, '2026-10-01', '2026-10-01')
    db.prepare("INSERT INTO customer_orders(id,tenant_id,created_at,updated_at) VALUES(?,?,?,?)")
      .run(order, tenant, '2026-10-01', '2026-10-01')
    db.prepare(`INSERT INTO customer_returns(id,tenant_id,sale_id,reason,refund_method,stock_action,created_at,updated_at)
      VALUES(?,?,?,'other','cash','return_to_stock',?,?)`).run(returned, tenant, sale, '2026-10-01', '2026-10-01')
    db.prepare(`UPDATE salary_payments SET amount=-250,source='commission_reversal',
      commission_source_sale_id=?,commission_source_order_id=?,commission_source_return_id=? WHERE id=?`)
      .run(sale, order, returned, payment.id)
    op.payload.amount = -250; op.payload.source = 'commission_reversal'
    for (const key of ['created_by', 'commission_source_sale_id', 'commission_source_order_id', 'commission_source_return_id']) delete op.payload[key]
    return op
  }
  function outgoingDelete(): any {
    const row = db.prepare("SELECT * FROM sync_outbox WHERE operation_type='salary_payment.deleted' AND aggregate_id=?").get(payment.id) as any
    return { ...row, payload: JSON.parse(row.payload_json) }
  }
  it('queues the exact original payment snapshot when deleting a manual ledger row', () => {
    const original = outgoing().payload
    new LocalStaffRepository(db).deleteSalary(payment.id)
    const op = outgoingDelete()
    expect(op.payload).toEqual({ id: payment.id, deleted_payment: original })
    expect((db.prepare('SELECT deleted_at FROM salary_payments WHERE id=?').get(payment.id) as any).deleted_at).toBe(op.created_at)
  })
  it('enriches legacy deletion read-only from the same local tombstone', () => {
    const original = outgoing().payload
    new LocalStaffRepository(db).deleteSalary(payment.id)
    const op = outgoingDelete(); op.payload = { id: payment.id }
    const queue = db.prepare('SELECT * FROM sync_outbox').all(), stored = db.prepare('SELECT * FROM salary_payments').all()
    db.exec('PRAGMA query_only=ON')
    try {
      expect(attachBalanceSnapshots(db, [op])[0].payload.deleted_payment).toEqual(original)
      expect(op.payload.deleted_payment).toBeUndefined()
      expect(db.prepare('SELECT * FROM sync_outbox').all()).toEqual(queue)
      expect(db.prepare('SELECT * FROM salary_payments').all()).toEqual(stored)
    } finally { db.exec('PRAGMA query_only=OFF') }
  })
  it.each(['active', 'another_deletion_time', 'foreign_tenant', 'automatic', 'missing', 'mismatched_payload_id'])
  ('does not attach an unsafe deletion snapshot: %s', mode => {
    new LocalStaffRepository(db).deleteSalary(payment.id)
    const op = outgoingDelete(); op.payload = { id: payment.id }
    if (mode === 'active') db.prepare('UPDATE salary_payments SET deleted_at=NULL').run()
    if (mode === 'another_deletion_time') db.prepare('UPDATE salary_payments SET deleted_at=?').run('2026-10-03T10:00:00Z')
    if (mode === 'foreign_tenant') db.prepare('UPDATE salary_payments SET tenant_id=?').run(randomUUID())
    if (mode === 'automatic') db.prepare("UPDATE salary_payments SET source='daily_rate'").run()
    if (mode === 'missing') db.prepare('DELETE FROM salary_payments').run()
    if (mode === 'mismatched_payload_id') op.payload.id = randomUUID()
    expect(attachBalanceSnapshots(db, [op])[0].payload.deleted_payment).toBeUndefined()
  })
  it.each([null, { id: 'keep-explicit' }])('does not overwrite an explicit deletion snapshot %j', value => {
    new LocalStaffRepository(db).deleteSalary(payment.id)
    const op = outgoingDelete(); op.payload.deleted_payment = value
    expect(attachBalanceSnapshots(db, [op])[0].payload.deleted_payment).toEqual(value)
  })
  it('retains salary/cash linkage in a committed local deletion, without reversing an owner contribution', () => {
    const shift = randomUUID()
    db.prepare(`INSERT INTO shifts(id,tenant_id,cashier_id,status,opening_cash,opened_at,created_at,updated_at)
      VALUES(?,?,?,'open',0,?,?,?)`).run(shift, tenant, actor, '2026-10-04', '2026-10-04', '2026-10-04')
    db.prepare(`INSERT INTO cash_operations(id,tenant_id,shift_id,user_id,type,source,amount,created_at,updated_at)
      VALUES(?,?,?,?,'cash_in','owner_funds',1250,?,?)`).run(randomUUID(), tenant, shift, actor, '2026-10-04', '2026-10-04')
    payment = new LocalStaffRepository(db).createSalary({ employee_id: employee, type: 'advance', method: 'cash',
      amount: 1250, user_id: actor, shift_id: shift, work_date: '2026-10-02', period: '2026-10' })
    const original = outgoing().payload
    new LocalStaffRepository(db).deleteSalary(payment.id)
    expect(outgoingDelete().payload.deleted_payment).toEqual(original)
    const cashRow = db.prepare('SELECT deleted_at FROM cash_operations WHERE id=?').get(payment.cash_operation_id) as any
    expect(cashRow.deleted_at).toBe(outgoingDelete().created_at)
    expect(db.prepare("SELECT id FROM cash_operations WHERE type='cash_in' AND deleted_at IS NULL").all()).toHaveLength(1)
    expect(db.prepare("SELECT id FROM cash_operations WHERE type='salary_payout' AND deleted_at IS NULL").all()).toHaveLength(0)
  })
  it('keeps a closed-shift payout immutable and does not queue any deletion', () => {
    const shift = randomUUID()
    db.prepare(`INSERT INTO shifts(id,tenant_id,cashier_id,status,opening_cash,opened_at,created_at,updated_at)
      VALUES(?,?,?,'open',50000,?,?,?)`).run(shift, tenant, actor, '2026-10-04', '2026-10-04', '2026-10-04')
    payment = new LocalStaffRepository(db).createSalary({ employee_id: employee, type: 'advance', method: 'cash',
      amount: 1250, user_id: actor, shift_id: shift, work_date: '2026-10-02', period: '2026-10' })
    db.prepare("UPDATE shifts SET status='closed' WHERE id=?").run(shift)
    expect(() => new LocalStaffRepository(db).deleteSalary(payment.id)).toThrow('закритої касової зміни')
    expect(db.prepare("SELECT * FROM sync_outbox WHERE operation_type='salary_payment.deleted'").all()).toHaveLength(0)
    expect(db.prepare('SELECT id FROM salary_payments WHERE id=? AND deleted_at IS NULL').get(payment.id)).toBeTruthy()
  })
  it('new operations contain explicit original actor and provenance fields', () => {
    expect(outgoing().payload).toMatchObject({ created_by: actor, commission_source_sale_id: null,
      commission_source_order_id: null, commission_source_return_id: null, amount: 1250, work_date: '2026-10-02' })
  })
  it('preserves a null original actor instead of inventing one', () => {
    const next = new LocalStaffRepository(db).createSalary({ employee_id: employee, type: 'bonus', method: 'transfer', amount: 1250 })
    expect(next.created_by).toBeNull()
  })
  it('enriches old copies read-only, without modifying money, original payload or outbox', () => {
    const op = legacy(), before = db.prepare('SELECT * FROM salary_payments').all(), queue = db.prepare('SELECT * FROM sync_outbox').all()
    db.exec('PRAGMA query_only=ON')
    try {
      const copy = attachBalanceSnapshots(db, [op])[0]
      expect(copy.payload).toMatchObject({ amount: -250, created_by: actor, commission_source_sale_id: sale,
        commission_source_order_id: order, commission_source_return_id: returned, work_date: '2026-10-02' })
      expect(op.payload.created_by).toBeUndefined()
      expect(db.prepare('SELECT * FROM salary_payments').all()).toEqual(before)
      expect(db.prepare('SELECT * FROM sync_outbox').all()).toEqual(queue)
    } finally { db.exec('PRAGMA query_only=OFF') }
  })
  it.each([
    ['amount', -251], ['employee_id', randomUUID()], ['source', 'manual'],
    ['type', 'salary'], ['method', 'cash'], ['period', '2026-09'], ['work_date', '2026-10-03'],
    ['cash_operation_id', randomUUID()], ['note', 'Інша операція'], ['created_at', '2026-10-01T00:00:00Z'],
  ])('does not merge provenance into a different queued decision: %s', (field, value) => {
    const op = legacy(); op.payload[field] = value
    const copy = attachBalanceSnapshots(db, [op])[0]
    expect(copy.payload.created_by).toBeUndefined()
    expect(copy.payload.commission_source_sale_id).toBeUndefined()
  })
  it.each(['deleted', 'foreign', 'missing'])('does not enrich from a %s local record', mode => {
    const op = legacy()
    if (mode === 'deleted') db.prepare('UPDATE salary_payments SET deleted_at=? WHERE id=?').run('2026-10-04', payment.id)
    if (mode === 'foreign') db.prepare('UPDATE salary_payments SET tenant_id=? WHERE id=?').run(randomUUID(), payment.id)
    if (mode === 'missing') db.prepare('DELETE FROM salary_payments WHERE id=?').run(payment.id)
    expect(attachBalanceSnapshots(db, [op])[0].payload.created_by).toBeUndefined()
  })
  it('does not override explicit null or explicit conflicting provenance', () => {
    const op = legacy(), wrong = randomUUID()
    op.payload.created_by = null; op.payload.commission_source_return_id = wrong
    const copy = attachBalanceSnapshots(db, [op])[0]
    expect(copy.payload.created_by).toBeNull()
    expect(copy.payload.commission_source_return_id).toBe(wrong)
  })
  it('does not enrich an aggregate/payload identity mismatch', () => {
    const op = legacy(); op.payload.id = randomUUID()
    expect(attachBalanceSnapshots(db, [op])[0].payload.created_by).toBeUndefined()
  })
  it('does not touch unrelated operation payloads', () => {
    const op = legacy(); op.operation_type = 'sale.created'
    expect(attachBalanceSnapshots(db, [op])[0].payload.created_by).toBeUndefined()
  })
})
