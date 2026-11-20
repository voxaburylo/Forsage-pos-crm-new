import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'

describe('forgotten shifts close automatically after 2 days (owner, 20.11.2026)', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository, cashier: string, other: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-stale-shift-')); db = new LocalDatabase(root); pos = new LocalPosRepository(db)
    cashier = randomUUID(); other = randomUUID()
    const now = new Date().toISOString()
    for (const [id, name] of [[cashier, 'Олексій'], [other, 'Володимир']])
      db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, DEFAULT_TENANT_ID, name, 'cashier', now, now)
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-stale-shift-')) rmSync(root, { recursive: true, force: true })
  })
  const age = (id: string, opened: string) => db.prepare('UPDATE shifts SET opened_at=? WHERE id=?').run(opened, id)

  it('closes only shifts open for more than 2 days, with the expected cash and a note', () => {
    const old = pos.openShift({ cashier_id: cashier, opening_cash: 125940 })
    const fresh = pos.openShift({ cashier_id: other, opening_cash: 5000 })
    age(old, '2026-11-15T10:14:42.145Z'); age(fresh, '2026-11-19T12:00:00.000Z')
    const closed = pos.autoCloseStaleShifts(new Date('2026-11-20T18:00:00Z'))
    expect(closed).toEqual([{ id: old, cashier_id: cashier, expected_cash: 125940 }])
    const row = db.prepare('SELECT status, closing_cash, expected_cash, cash_variance, notes FROM shifts WHERE id=?').get(old) as Record<string, unknown>
    expect(row).toMatchObject({ status: 'closed', closing_cash: 125940, expected_cash: 125940, cash_variance: 0 })
    expect(String(row.notes)).toContain('закрито автоматично')
    expect(pos.listOpenShifts().map(shift => shift.id)).toEqual([fresh])
    expect(pos.autoCloseStaleShifts(new Date('2026-11-20T18:00:00Z'))).toEqual([])
  })

  it('a cashier cannot close somebody else’s shift', () => {
    const id = pos.openShift({ cashier_id: cashier, opening_cash: 0 })
    expect(() => pos.closeShift(cashier, 0, 'x', id, DEFAULT_TENANT_ID, 'cashier', other)).toThrow('Недостатньо прав')
    pos.closeShift(cashier, 0, null, id)
    expect(pos.listOpenShifts()).toEqual([])
  })
})
