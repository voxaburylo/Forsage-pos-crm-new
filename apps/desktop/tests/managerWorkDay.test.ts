import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalStaffRepository } from '../src/repositories/staffRepository'

// 26.11.2026, рішення власника: «денна ставка менеджера — за день, коли він увійшов у програму».
describe('manager day rate for the day he worked in the program', () => {
  let root: string, db: LocalDatabase, staff: LocalStaffRepository
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-26T08:00:00Z'))
    root = mkdtempSync(path.join(tmpdir(), 'forsage-workday-'))
    db = new LocalDatabase(root); staff = new LocalStaffRepository(db)
    const user = (id: string, role: string, rate: number, period = 'day', active = 1) => db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,is_active,base_rate,rate_period,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, tenant, 'Name ' + id, role, active, rate, period, new Date().toISOString(), new Date().toISOString())
    user('manager', 'manager', 60000); user('monthly', 'manager', 1500000, 'month'); user('cashier', 'cashier', 50000); user('off', 'manager', 60000, 'day', 0)
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); vi.useRealTimers() })

  it('the first action of the day accrues the day rate once; the next day accrues again', () => {
    expect(staff.accrueManagerWorkDay('manager')).toBe(true)
    expect(staff.accrueManagerWorkDay('manager')).toBe(false)
    expect(staff.dailySummary('2026-11-26').find(row => row.employee_id === 'manager')).toMatchObject({ earned: 60000, balance: 60000 })
    expect(staff.salarySummary('2026-11').find((row: any) => row.employee_id === 'manager')?.earned).toBe(60000)
    vi.setSystemTime(new Date('2026-11-27T07:00:00Z'))
    expect(staff.accrueManagerWorkDay('manager')).toBe(true)
    expect(staff.salarySummary('2026-11').find((row: any) => row.employee_id === 'manager')?.earned).toBe(120000)
  })

  it('only a manager with a day rate; a cashier still gets it at the payout; inactive or monthly — nothing', () => {
    expect(staff.accrueManagerWorkDay('cashier')).toBe(false)
    expect(staff.accrueManagerWorkDay('monthly')).toBe(false)
    expect(staff.accrueManagerWorkDay('off')).toBe(false)
    expect(staff.accrueManagerWorkDay('missing')).toBe(false)
  })

  it('a payout at the till the same day does not add the day rate a second time', () => {
    const pos = new LocalPosRepository(db)
    db.prepare("INSERT INTO staff_users(id,tenant_id,full_name,role,is_active,base_rate,rate_period,created_at,updated_at) VALUES ('owner',?,'Власник','owner',1,0,'day',?,?)").run(tenant, new Date().toISOString(), new Date().toISOString())
    const shift = pos.openShift({ cashier_id: 'cashier', opening_cash: 100000 })
    staff.accrueManagerWorkDay('manager')
    staff.dailyPayout({ employee_id: 'manager', method: 'cash', fund_source: 'cashbox', shift_id: shift, work_date: '2026-11-26', user_id: 'cashier' })
    const rates = db.prepare("SELECT count(*) AS n FROM salary_payments WHERE employee_id='manager' AND source='daily_rate' AND deleted_at IS NULL").get() as { n: number }
    expect(rates.n).toBe(1)
  })

  it('the main PC notes the day on a manager action, not on the manager PC', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main).toContain("if (session.role === 'manager' && localNetwork?.getStatus().mode !== 'client') noteManagerWorkDay(session.id, session.tenant_id)")
  })
})
