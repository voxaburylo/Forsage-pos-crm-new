import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalStaffRepository } from '../src/repositories/staffRepository'
let root: string, db: LocalDatabase, staff: LocalStaffRepository
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-pay-history-')); db = new LocalDatabase(root); staff = new LocalStaffRepository(db) })
afterEach(() => { db.close(); if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-pay-history-')) rmSync(root, { recursive: true, force: true }) })
it('reads beyond 200 operations with deterministic ties and full unchanged totals', () => {
  const ts = '2026-09-22T00:00:00.000Z'
  db.transaction(() => {
    db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('worker', DEFAULT_TENANT_ID, 'Тест', 'cashier', ts, ts)
    const insert = db.prepare(`INSERT INTO salary_payments(id,tenant_id,employee_id,employee_name,amount,type,method,period,work_date,created_at,updated_at) VALUES (?,?,'worker','Тест',100,'salary','cash','2026-09','2026-09-22',?,?)`)
    for (let i = 0; i < 451; i++) insert.run(String(i).padStart(5, '0'), DEFAULT_TENANT_ID, ts, ts)
  })
  const rows = [1, 2, 3].flatMap(page => staff.listSalary({ period: '2026-09', page }))
  expect(rows).toHaveLength(451); expect(new Set(rows.map(row => row.id)).size).toBe(451)
  expect(rows[0].id).toBe('00450'); expect(rows.at(-1)?.id).toBe('00000')
  expect(staff.salarySummary('2026-09')[0].earned).toBe(45100)
  expect(staff.listSalary({ tenant_id: 'other', page: 1 })).toEqual([])
  expect(staff.listSalary({ period: '2026-08' })).toEqual([])
  expect(() => staff.listSalary({ page: -1 })).toThrow('сторінка')
})
