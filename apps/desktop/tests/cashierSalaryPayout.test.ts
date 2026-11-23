import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalStaffRepository } from '../src/repositories/staffRepository'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'
import { webRpcChannelAllowed } from '../src/lan/webRpcChannels'

// 23.11.2026 (власник): касир наприкінці дня видає зарплату з каси й закриває зміну;
// якщо готівки бракує — власник доносить свої гроші («коштами власника»).
describe('cashier pays the day salary at the till', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository, staff: LocalStaffRepository, shift: string
  const workDate = '2026-11-23'
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-23T15:00:00Z'))
    root = mkdtempSync(path.join(tmpdir(), 'forsage-payout-'))
    db = new LocalDatabase(root); pos = new LocalPosRepository(db); staff = new LocalStaffRepository(db)
    const user = (id: string, role: string, rate = 0, active = 1) => db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,is_active,base_rate,rate_period,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, tenant, 'Name ' + id, role, active, rate, 'day', new Date().toISOString(), new Date().toISOString())
    user('owner', 'owner'); user('cashier', 'cashier'); user('daily', 'manager', 50000); user('tire', 'tire_worker'); user('gone', 'cashier', 0, 0)
    shift = pos.openShift({ cashier_id: 'cashier', opening_cash: 30000 })
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); vi.useRealTimers() })

  it('lists who gets how much today: earned plus a day rate not yet accrued, minus paid; no owner, tire workers or inactive staff', () => {
    staff.createSalary({ employee_id: 'cashier', amount: 12000, type: 'bonus', method: 'cash', work_date: workDate })
    const rows = staff.payoutList(workDate)
    expect(rows.map(row => row.employee_id).sort()).toEqual(['cashier', 'daily'])
    expect(rows.find(row => row.employee_id === 'cashier')).toMatchObject({ earned: 12000, pending_day_rate: 0, due: 12000 })
    expect(rows.find(row => row.employee_id === 'daily')).toMatchObject({ earned: 0, pending_day_rate: 50000, due: 50000 })
  })

  it('paying from the till takes the day rate too, and the list then shows nothing due', () => {
    staff.createSalary({ employee_id: 'daily', amount: 0 + 5000, type: 'bonus', method: 'cash', work_date: workDate })
    expect(() => staff.dailyPayout({ employee_id: 'daily', method: 'cash', fund_source: 'cashbox', shift_id: shift, work_date: workDate, user_id: 'cashier' }))
      .toThrow('У касі недостатньо готівки')
    const paid = staff.dailyPayout({ employee_id: 'daily', method: 'cash', fund_source: 'owner_funds', shift_id: shift, work_date: workDate, user_id: 'cashier' })
    expect(paid.amount).toBe(55000)
    expect(staff.payoutList(workDate).find(row => row.employee_id === 'daily')).toMatchObject({ earned: 55000, pending_day_rate: 0, paid: 55000, due: 0 })
    // Гроші власника не змінюють залишок каси: внесено й одразу видано.
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(30000)
  })

  it('a cashier may see the list and pay, but only at the till — money through the web stays closed', () => {
    for (const channel of ['desktop:staff:payout-list', 'desktop:staff:daily-payout']) {
      expect(isDesktopChannelAllowed(channel, 'cashier')).toBe(true)
      expect(isDesktopChannelAllowed(channel, 'storekeeper')).toBe(false)
    }
    expect(isDesktopChannelAllowed('desktop:staff:create-salary', 'cashier')).toBe(false)
    expect(isDesktopChannelAllowed('desktop:staff:delete-salary', 'cashier')).toBe(false)
    expect(webRpcChannelAllowed('desktop:staff:daily-payout')).toBe(false)
  })
})
