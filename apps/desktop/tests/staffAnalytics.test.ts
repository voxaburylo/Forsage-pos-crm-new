import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { localAnalytics } from '../src/repositories/localAnalytics'

let root: string, db: LocalDatabase, shift: string
const timestamp = '2026-10-04T10:00:00.000Z'
const input = { kind: 'staff' as const, startDate: '2026-10-04', endDate: '2026-10-04',
  from: '2026-10-03T21:00:00.000Z', to: '2026-10-04T20:59:59.999Z' }
const staff = (id: string, name = 'Працівник ' + id) => db.prepare(
  'INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)')
  .run(id, tenant, name, 'cashier', timestamp, timestamp)
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
  root = mkdtempSync(path.join(tmpdir(), 'forsage-staff-report-'))
  db = new LocalDatabase(root); staff('seller'); staff('manager')
  shift = new LocalPosRepository(db).openShift({ cashier_id: 'seller' })
})
afterEach(() => {
  db.close(); vi.useRealTimers()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-staff-report-')) rmSync(root, { recursive: true, force: true })
})
function sale(id = 's', manager: string | null = null, total = 10000, qty = 1, cost = 6000, at = timestamp) {
  db.prepare(`INSERT INTO sales(id,tenant_id,sale_number,cashier_id,manager_id,shift_id,status,total,payment_method,completed_at,created_at,updated_at)
    VALUES (?,?,?,'seller',?,?,'completed',?,'cash',?,?,?)`).run(id, tenant, id, manager, shift, total, at, at, at)
  db.prepare(`INSERT INTO sale_items(id,tenant_id,sale_id,qty,unit_price,purchase_price,total,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, tenant, id, qty, Math.round(total / qty), cost, total, at, at)
}
function order(id = 'o', saleId: string | null = 's', manager = 'manager') {
  db.prepare(`INSERT INTO customer_orders(id,tenant_id,manager_id,status,sale_id,total_amount,created_at,updated_at)
    VALUES (?,?,?,'completed',?,990000,?,?)`).run(id, tenant, manager, saleId, timestamp, timestamp)
}
function salary(type = 'salary', amount = 1000, date = '2026-10-04', source = 'manual') {
  db.prepare(`INSERT INTO salary_payments(id,tenant_id,employee_id,employee_name,type,amount,method,period,work_date,source,created_at,updated_at)
    VALUES (?,?,'seller','Збережене ім’я',?,?,'cash','2026-10',?,?,?,?)`)
    .run(randomUUID(), tenant, type, amount, date, source, '2026-10-08T10:00:00Z', timestamp)
}
const row = (id = 'seller') => localAnalytics(db, input).find(row => row.manager_id === id)
it('does not lose sales when the cashier card is absent', () => {
  sale(); db.prepare("UPDATE sales SET cashier_id='missing'").run()
  expect(row('missing')).toMatchObject({ total_revenue: 10000, gross_profit: 4000 })
})
it('keeps historical turnover for an archived employee', () => {
  sale(); db.prepare("UPDATE staff_users SET deleted_at=?,is_active=0 WHERE id='seller'").run(timestamp)
  expect(row()).toMatchObject({ manager_name: 'Працівник seller', total_revenue: 10000 })
})
it('uses the employee saved in the receipt ahead of an edited order manager', () => {
  sale('s', 'seller'); order('o', 's', 'manager')
  expect(row()).toMatchObject({ orders_revenue: 10000, sales_revenue: 0 })
  expect(row('manager').total_revenue).toBe(0)
})
it('uses the linked order manager for a legacy receipt with no manager', () => {
  sale(); order()
  expect(row('manager')).toMatchObject({ orders_revenue: 10000, total_revenue: 10000 })
})
it('does not count an unpaid or unissued order as income', () => {
  order('not-issued', null)
  expect(localAnalytics(db, input).reduce((sum, row) => sum + row.total_revenue, 0)).toBe(0)
})
it('rejects a duplicated order-receipt link rather than doubling turnover', () => {
  sale(); order(); order('second')
  expect(() => localAnalytics(db, input)).toThrow('кількох замовлень')
})
it('keeps rounding consistent between cost components and total', () => {
  sale('s', null, 4, .4, 1); sale('s2', null, 4, .4, 1); order('o', 's', 'seller')
  expect(row()).toMatchObject({ total_cogs: 1, sales_cogs: 0, orders_cogs: 1, gross_profit: 7 })
})
it('counts salary by work date and does not deduct its actual payout twice', () => {
  sale(); salary(); salary('bonus', 200); salary('penalty', 50); salary('advance', 900)
  salary('bonus', -100, '2026-10-04', 'commission_reversal')
  expect(row()).toMatchObject({ salary_cost: 1000, bonus_cost: 100, penalty_cost: 50, total_payouts: 900, net_profit: 2950 })
})
it('does not pull salary of a different work day into the selected period', () => {
  salary('salary', 1000, '2026-10-03')
  expect(row().salary_cost).toBe(0)
})
it('keeps owner turnover without reviving legacy owner salary debt', () => {
  sale(); salary(); db.prepare("UPDATE staff_users SET role='owner' WHERE id='seller'").run()
  expect(row()).toMatchObject({ total_revenue: 10000, salary_cost: 0, total_payouts: 0, net_profit: 4000 })
  expect(db.prepare('SELECT COUNT(*) n FROM salary_payments').get()).toMatchObject({ n: 1 })
})
it('does not include deleted payroll records', () => {
  salary(); db.prepare('UPDATE salary_payments SET deleted_at=?').run(timestamp)
  expect(row().salary_cost).toBe(0)
})
it.each([-1, .5])('rejects malformed non-reversal salary amount %s', amount => {
  salary('salary', amount)
  expect(() => localAnalytics(db, input)).toThrow('некоректне нарахування')
})
it.each(['2026-02-30', '2026-13-01', '2026-1-01', '', '9999-01-01'])('rejects invalid work-day boundary %s', startDate => {
  expect(() => localAnalytics(db, { ...input, startDate })).toThrow('Некоректний період')
})
it('rejects reversed salary dates even if timestamp input looks valid', () => {
  expect(() => localAnalytics(db, { ...input, startDate: '2026-10-05' })).toThrow('Некоректний період')
})
it('reads salary and turnover from one snapshot during concurrent updates', () => {
  sale(); salary()
  const writer = new LocalDatabase(root), prepare = db.prepare.bind(db)
  let changed = false
  const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    if (!changed && sql.includes('SELECT employee_id, employee_name, type, amount, source')) {
      changed = true; writer.prepare('UPDATE salary_payments SET amount=4000').run()
    }
    return prepare(sql)
  })
  try {
    expect(row().net_profit).toBe(3000)
    expect(changed).toBe(true)
    expect(row().net_profit).toBe(0)
  } finally { spy.mockRestore(); writer.close() }
})
it('does not write payroll or outbox when calculating a report', () => {
  sale(); salary()
  const before = db.prepare('SELECT * FROM salary_payments').all()
  const outbox = db.prepare('SELECT * FROM sync_outbox').all()
  expect(localAnalytics(db, input)).toEqual(localAnalytics(db, input))
  expect(db.prepare('SELECT * FROM salary_payments').all()).toEqual(before)
  expect(db.prepare('SELECT * FROM sync_outbox').all()).toEqual(outbox)
})
