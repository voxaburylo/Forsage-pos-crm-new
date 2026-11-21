import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'

describe('owner closes a forgotten cashier shift (20.11.2026)', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository, cashier: string, owner: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-stale-shift-')); db = new LocalDatabase(root); pos = new LocalPosRepository(db)
    cashier = randomUUID(); owner = randomUUID()
    const now = new Date().toISOString()
    for (const [id, name, role] of [[cashier, 'Олексій', 'cashier'], [owner, 'Власник', 'owner']])
      db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, DEFAULT_TENANT_ID, name, role, now, now)
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-stale-shift-')) rmSync(root, { recursive: true, force: true })
  })

  it('lists open shifts with the expected cash', () => {
    const id = pos.openShift({ cashier_id: cashier, opening_cash: 125940 })
    expect(pos.listOpenShifts()).toEqual([expect.objectContaining({ id, cashier_id: cashier, cashier_name: 'Олексій', expected_cash: 125940 })])
  })

  it('owner closes it with a reason; a cashier cannot close somebody else’s shift', () => {
    const id = pos.openShift({ cashier_id: cashier, opening_cash: 125940 })
    const other = randomUUID()
    expect(() => pos.closeShift(cashier, 125940, 'закрито', id, DEFAULT_TENANT_ID, 'cashier', other)).toThrow('Недостатньо прав')
    expect(() => pos.closeShift(cashier, 125940, '  ', id, DEFAULT_TENANT_ID, 'owner', owner)).toThrow('Вкажіть, чому')
    expect(pos.listOpenShifts()).toHaveLength(1)
    pos.closeShift(cashier, 125940, 'Касир забув закрити', id, DEFAULT_TENANT_ID, 'owner', owner)
    const row = db.prepare('SELECT status, closing_cash, expected_cash, cash_variance, notes FROM shifts WHERE id=?').get(id) as Record<string, unknown>
    expect(row).toMatchObject({ status: 'closed', closing_cash: 125940, expected_cash: 125940, cash_variance: 0 })
    expect(String(row.notes)).toContain('Касир забув закрити')
    expect(pos.listOpenShifts()).toEqual([])
  })

  it('a cashier still closes their own shift without a comment', () => {
    const id = pos.openShift({ cashier_id: cashier, opening_cash: 0 })
    pos.closeShift(cashier, 0, null, id)
    expect(pos.listOpenShifts()).toEqual([])
  })
})
