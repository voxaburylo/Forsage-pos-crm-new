import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalStaffRepository } from '../src/repositories/staffRepository'

type Kind = 'salary' | 'daily-salary'
const owner = 'recovery-owner', otherOwner = 'recovery-other-owner', worker = 'recovery-worker'
const beforeMidnight = '2026-09-30T20:59:59.000Z', afterMidnight = '2026-09-30T21:00:00.000Z'

describe('salary receipt resolution without replaying financial writes', () => {
  let root: string, db: LocalDatabase, staff: LocalStaffRepository, pos: LocalPosRepository, shift: string
  const key = (kind: Kind, id = 'original') => `mutation:${kind}:${tenant}:${id}`
  function connect() { db = new LocalDatabase(root); staff = new LocalStaffRepository(db); pos = new LocalPosRepository(db) }
  function reopen() {
    const previous = db, identity = db.deviceId, databasePath = db.databasePath
    db.close(); connect()
    expect(db).not.toBe(previous); expect(db.deviceId).toBe(identity); expect(db.databasePath).toBe(databasePath)
  }
  function snapshot(includeMeta = true) {
    return db.readSnapshot(() => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
      return Object.fromEntries(tables.filter(({ name }) => includeMeta || name !== 'app_meta').map(({ name }) => [name,
        db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ]))
    })
  }
  function write(kind: Kind, operationId = 'original') {
    const shared = { operation_id: operationId, tenant_id: tenant, employee_id: worker, employee_name: 'Worker',
      user_id: owner, method: 'cash' as const, shift_id: shift, work_date: '2026-09-30' }
    return kind === 'salary'
      ? staff.createSalary({ ...shared, amount: 12650, type: 'advance', period: '2026-09', note: 'Retained form' })
      : staff.dailyPayout({ ...shared, fund_source: 'cashbox' })
  }
  function receipt(kind: Kind) {
    return JSON.parse((db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(key(kind)) as { value_json: string }).value_json)
  }
  function setReceipt(kind: Kind, value: unknown) {
    db.prepare('UPDATE app_meta SET value_json=? WHERE key=?').run(typeof value === 'string' ? value : JSON.stringify(value), key(kind))
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(beforeMidnight))
    root = mkdtempSync(path.join(tmpdir(), 'forsage-staff-recovery-')); connect()
    for (const [id, role, userTenant] of [[owner, 'owner', tenant], [otherOwner, 'owner', tenant],
      [worker, 'cashier', tenant], ['foreign-owner', 'owner', 'foreign-tenant']]) {
      db.prepare(`INSERT INTO staff_users(id,tenant_id,full_name,role,is_active,base_rate,rate_period,created_at,updated_at)
        VALUES (?,?,?,?,1,12650,'day',?,?)`).run(id, userTenant, id, role, beforeMidnight, beforeMidnight)
    }
    shift = pos.openShift({ cashier_id: owner, opening_cash: 50000 })
  })
  afterEach(() => {
    try { db?.close() } finally {
      vi.useRealTimers()
      const resolved = path.resolve(root)
      if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('forsage-staff-recovery-')
        || realpathSync(resolved) !== resolved) throw new Error('Unsafe synthetic database cleanup')
      rmSync(resolved, { recursive: true, force: true })
    }
  })

  for (const kind of ['salary', 'daily-salary'] as const) {
    it(`${kind}: returns the committed result after midnight, shift closure and real reopen without any write`, () => {
      const saved = write(kind)
      expect(pos.getExpectedCash(owner)?.expected_amount).toBe(37350)
      vi.setSystemTime(new Date(afterMidnight))
      pos.closeShift(owner, 37350, 'Synthetic close', shift)
      const before = snapshot(); reopen(); expect(snapshot()).toEqual(before)
      for (let i = 0; i < 2; i++) {
        expect(staff.resolveOperation(kind, 'original', owner)).toEqual({ status: 'committed', result: saved })
        expect(snapshot()).toEqual(before)
      }
      // Exact old-payload replay remains a cached receipt, not a newly payable day.
      expect(write(kind)).toEqual(saved); expect(snapshot()).toEqual(before)
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    })

    it(`${kind}: missing receipt is fenced atomically and the delayed original write stays blocked after reopen`, () => {
      const beforeBusiness = snapshot(false)
      expect(staff.resolveOperation(kind, 'original', owner)).toEqual({ status: 'not_committed' })
      expect(receipt(kind)).toEqual({ cancelled: true, cancelled_by: owner })
      expect(snapshot(false)).toEqual(beforeBusiness)
      const fenced = snapshot(); vi.setSystemTime(new Date(afterMidnight)); reopen()
      expect(staff.resolveOperation(kind, 'original', owner)).toEqual({ status: 'not_committed' })
      expect(() => write(kind)).toThrow('закрито без проведення')
      expect(snapshot()).toEqual(fenced)
      // Only an explicitly new identity can start a genuinely new operation.
      expect(write(kind, 'explicit-new')).toBeTruthy()
      expect(pos.getExpectedCash(owner)?.expected_amount).toBe(37350)
    })

    it(`${kind}: another actor cannot claim a committed receipt or alter its evidence`, () => {
      write(kind); const before = snapshot()
      expect(() => staff.resolveOperation(kind, 'original', otherOwner)).toThrow('іншому працівнику')
      expect(() => staff.resolveOperation(kind, 'original', owner, 'foreign-tenant')).toThrow('іншому працівнику')
      expect(snapshot()).toEqual(before)
    })

    it(`${kind}: fences remain actor-bound and tenant-isolated`, () => {
      write(kind)
      expect(staff.resolveOperation(kind, 'original', 'foreign-owner', 'foreign-tenant')).toEqual({ status: 'not_committed' })
      expect(staff.resolveOperation(kind, 'original', owner).status).toBe('committed')
      staff.resolveOperation(kind, 'absent', owner); const before = snapshot()
      expect(() => staff.resolveOperation(kind, 'absent', otherOwner)).toThrow('іншому працівнику')
      expect(snapshot()).toEqual(before)
    })

    it(`${kind}: a rolled-back salary write resolves as absent and cannot arrive late`, () => {
      db.exec("CREATE TRIGGER fixture_fail_salary BEFORE INSERT ON salary_payments BEGIN SELECT RAISE(ABORT,'synthetic salary failure'); END")
      const before = snapshot()
      expect(() => write(kind)).toThrow('synthetic salary failure'); expect(snapshot()).toEqual(before)
      expect(staff.resolveOperation(kind, 'original', owner)).toEqual({ status: 'not_committed' })
      db.exec('DROP TRIGGER fixture_fail_salary'); const fenced = snapshot(); reopen()
      expect(() => write(kind)).toThrow('закрито без проведення'); expect(snapshot()).toEqual(fenced)
    })
  }

  it('keeps an actually deleted manual payment committed, with its original result and no re-payment', () => {
    const saved = write('salary') as any
    staff.deleteSalary(saved.id)
    expect(pos.getExpectedCash(owner)?.expected_amount).toBe(50000)
    const before = snapshot(); reopen()
    expect(staff.resolveOperation('salary', 'original', owner)).toEqual({ status: 'committed', result: saved })
    expect(write('salary')).toEqual(saved)
    expect(snapshot()).toEqual(before)
    expect(db.prepare('SELECT deleted_at FROM salary_payments WHERE id=?').get(saved.id)).toMatchObject({ deleted_at: beforeMidnight })
  })

  it.each(['abort', 'ignore', 'delete', 'alter'] as const)('never reports absence when the cancellation fence fails: %s', mode => {
    const statement = mode === 'abort' ? "BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'mutation:%' BEGIN SELECT RAISE(ABORT,'fence disk failure'); END"
      : mode === 'ignore' ? "BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'mutation:%' BEGIN SELECT RAISE(IGNORE); END"
        : mode === 'delete' ? "AFTER INSERT ON app_meta WHEN NEW.key LIKE 'mutation:%' BEGIN DELETE FROM app_meta WHERE key=NEW.key; END"
          : "AFTER INSERT ON app_meta WHEN NEW.key LIKE 'mutation:%' BEGIN UPDATE app_meta SET value_json='{}' WHERE key=NEW.key; END"
    db.exec('CREATE TRIGGER fixture_fence_failure ' + statement)
    const before = snapshot()
    expect(() => staff.resolveOperation('salary', 'original', owner)).toThrow()
    expect(snapshot()).toEqual(before)
    db.exec('DROP TRIGGER fixture_fence_failure')
    expect(write('salary')).toHaveProperty('id')
  })

  it.each(['broken json', 'null', '[]', '{}', '{"cancelled":true}',
    '{"cancelled":true,"cancelled_by":"recovery-owner","result":{}}',
    '{"fingerprint":"bad","result":{"id":"unknown"}}'])('preserves corrupt receipt evidence: %s', raw => {
    write('salary'); setReceipt('salary', raw); const before = snapshot()
    expect(() => staff.resolveOperation('salary', 'original', owner)).toThrow('Пошкоджений')
    expect(snapshot()).toEqual(before)
  })

  it.each(['id', 'amount', 'work_date', 'created_by', 'source'] as const)('rejects a receipt/document mismatch in %s', field => {
    write('salary'); const saved = receipt('salary')
    saved.result[field] = field === 'amount' ? 1 : 'different'
    setReceipt('salary', saved); const before = snapshot()
    expect(() => staff.resolveOperation('salary', 'original', owner)).toThrow()
    expect(snapshot()).toEqual(before)
  })

  it.each(['amount', 'earned', 'previously_paid', 'penalty', 'payment'] as const)('rejects malformed daily result %s without changes', field => {
    write('daily-salary'); const saved = receipt('daily-salary')
    saved.result[field] = field === 'payment' ? null : '12650'
    setReceipt('daily-salary', saved); const before = snapshot()
    expect(() => staff.resolveOperation('daily-salary', 'original', owner)).toThrow('Пошкоджений')
    expect(snapshot()).toEqual(before)
  })

  it.each(['', ' ', 'x'.repeat(201), null, 4])('rejects invalid identity before creating a fence: %s', id => {
    const before = snapshot()
    expect(() => staff.resolveOperation('salary', id as string, owner)).toThrow('Некоректна')
    expect(snapshot()).toEqual(before)
  })

  it('rejects unknown kinds, missing actor and unavailable document without silently reporting absence', () => {
    const saved = write('salary') as any
    db.prepare('DELETE FROM salary_payments WHERE id=?').run(saved.id)
    const before = snapshot()
    expect(() => staff.resolveOperation('salary', 'original', owner)).toThrow('документ недоступний')
    expect(() => staff.resolveOperation('bad' as Kind, 'new', owner)).toThrow('Некоректна')
    expect(() => staff.resolveOperation('salary', 'new', '')).toThrow('Некоректна')
    expect(() => staff.resolveOperation('salary', 'new', 'unknown')).toThrow('іншому працівнику')
    expect(snapshot()).toEqual(before)
  })
})
