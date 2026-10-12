import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({ local: undefined as any, actor: 'recovery-owner' }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: () => ({ staff: transport.local }) }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: {
  getState: () => ({ session: { user: { id: transport.actor } } }),
} }))
vi.mock('@/lib/api', () => ({ api: new Proxy({}, {
  get: () => () => { throw new Error('Network is forbidden in salary recovery fixtures') },
}) }))

// Load the other application's real entry points as a runtime integration boundary.
// Its TypeScript is checked by the web project, not emitted under desktop/rootDir.
const webModule = (relative: string) => import(new URL('../../web/src/' + relative, import.meta.url).href)
const { staffApi } = await webModule('features/staff/staffApi.ts')
const { pendingLocalRequests } = await webModule('lib/durableLocalRequest.ts')
const { businessDateKey } = await webModule('lib/businessDate.ts')
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalStaffRepository } from '../src/repositories/staffRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'

let root: string, db: LocalDatabase, staff: LocalStaffRepository, pos: LocalPosRepository
let shift: string
let calls: any[], results: any[], resolveCalls: any[]
let failResolve: boolean, loseReply: boolean, failBeforeCommit: boolean
const actor = 'recovery-owner', worker = 'recovery-worker'
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-30T20:59:59Z'))
  vi.stubGlobal('fetch', () => { throw new Error('Network is forbidden') })
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  })
  root = mkdtempSync(path.join(tmpdir(), 'forsage-salary-recovery-'))
  db = new LocalDatabase(root)
  staff = new LocalStaffRepository(db)
  pos = new LocalPosRepository(db)
  for (const [id, role] of [[actor, 'owner'], [worker, 'cashier']]) {
    db.prepare(`INSERT INTO staff_users
      (id,tenant_id,full_name,role,is_active,base_rate,rate_period,created_at,updated_at)
      VALUES (?,?,?,?,1,0,'day',?,?)`).run(id, tenant, id, role,
      '2026-09-30T20:00:00Z', '2026-09-30T20:00:00Z')
  }
  shift = pos.openShift({ cashier_id: actor, opening_cash: 50000 })
  calls = []; results = []; resolveCalls = []
  failResolve = false; loseReply = true; failBeforeCommit = false
  transport.actor = actor
  const send = (kind: 'salary' | 'daily-salary', input: any) => {
    calls.push({ kind, input: structuredClone(input) })
    if (failBeforeCommit) throw new Error('BEFORE_COMMIT')
    const payload = { ...input, user_id: transport.actor }
    const result = kind === 'salary' ? staff.createSalary(payload) : staff.dailyPayout(payload)
    results.push(result)
    if (loseReply) { loseReply = false; throw new Error('LOST_COMMITTED_REPLY') }
    return result
  }
  transport.local = {
    createSalary: async (input: any) => send('salary', input),
    dailyPayout: async (input: any) => send('daily-salary', input),
    resolveOperation: async (kind: 'salary' | 'daily-salary', id: string) => {
      resolveCalls.push({ kind, id })
      if (failResolve) throw new Error('RESOLUTION_UNAVAILABLE')
      return staff.resolveOperation(kind, id, transport.actor, tenant)
    },
  }
})
afterEach(() => {
  try { db?.close() } finally {
    vi.useRealTimers(); vi.unstubAllGlobals()
    if (root) {
      const resolved = path.resolve(root)
      if (path.dirname(resolved) !== path.resolve(tmpdir())
        || !path.basename(resolved).startsWith('forsage-salary-recovery-')
        || realpathSync(resolved) !== resolved) throw new Error('Unsafe fixture cleanup')
      rmSync(resolved, { recursive: true, force: true })
    }
  }
})
const payload = () => ({ employee_id: worker, employee_name: 'Synthetic worker',
  amount: 12650, type: 'advance', method: 'cash', period: '2026-09',
  note: 'Retained form', shift_id: shift, work_date: businessDateKey() })
const cash = () => pos.getExpectedCash(actor)?.expected_amount
const snapshot = () => db.readSnapshot(() => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
  return Object.fromEntries(tables.map(({ name }) => [name,
    db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]))
})
function reopen() {
  const before = snapshot(), device = db.deviceId, file = db.databasePath
  db.close(); db = new LocalDatabase(root)
  staff = new LocalStaffRepository(db); pos = new LocalPosRepository(db)
  expect(db.deviceId).toBe(device); expect(db.databasePath).toBe(file)
  expect(snapshot()).toEqual(before)
}
function validDatabase() {
  expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
}

it('recovers a committed manual payment after midnight without a second debit after actual reopen', async () => {
  failResolve = true
  await expect(staffApi.createSalary(payload())).rejects.toThrow('LOST_COMMITTED_REPLY')
  expect(cash()).toBe(37350)
  expect(pendingLocalRequests('salary:' + actor)).toHaveLength(1)
  vi.setSystemTime(new Date('2026-09-30T21:00:00Z'))
  reopen()
  const before = snapshot()
  // Exact old identity remains safe, even before frontend recovery resolves it.
  expect(staff.createSalary({ ...calls[0].input, user_id: actor })).toEqual(results[0])
  expect(snapshot()).toEqual(before)
  failResolve = false
  await expect(staffApi.createSalary(payload())).rejects.toThrow(/вже.*збереж|вже.*проведен/i)
  expect(calls).toHaveLength(1)
  expect(cash()).toBe(37350)
  expect(snapshot()).toEqual(before)
  expect(pendingLocalRequests('salary:' + actor)).toEqual([])
  expect(db.prepare('SELECT count(*) AS n FROM salary_payments').get()).toEqual({ n: 1 })
  expect(db.prepare('SELECT count(*) AS n FROM cash_operations').get()).toEqual({ n: 1 })
  validDatabase()
})

it('returns the saved payment immediately when only its reply was lost', async () => {
  const result = await staffApi.createSalary(payload())
  expect(result.data).toEqual(results[0])
  expect(calls).toHaveLength(1)
  expect(resolveCalls).toHaveLength(1)
  expect(pendingLocalRequests('salary:' + actor)).toEqual([])
  expect(cash()).toBe(37350)
  validDatabase()
})

it('keeps an unresolved old attempt and blocks a changed-day write until it can be resolved', async () => {
  failResolve = true
  await expect(staffApi.createSalary(payload())).rejects.toThrow('LOST_COMMITTED_REPLY')
  const before = snapshot(), pending = pendingLocalRequests('salary:' + actor)
  vi.setSystemTime(new Date('2026-09-30T21:00:00Z'))
  await expect(staffApi.createSalary(payload())).rejects.toThrow()
  expect(calls).toHaveLength(1)
  expect(snapshot()).toEqual(before)
  expect(pendingLocalRequests('salary:' + actor)).toEqual(pending)
})

it('fences an uncommitted old request before a new explicit attempt and rejects its late delivery', async () => {
  failResolve = true; failBeforeCommit = true
  await expect(staffApi.createSalary(payload())).rejects.toThrow('BEFORE_COMMIT')
  const oldInput = calls[0].input
  expect(cash()).toBe(50000)
  vi.setSystemTime(new Date('2026-09-30T21:00:00Z'))
  reopen()
  failResolve = false; failBeforeCommit = false; loseReply = false
  await staffApi.createSalary(payload())
  expect(calls).toHaveLength(2)
  expect(calls[1].input.operation_id).not.toBe(oldInput.operation_id)
  expect(cash()).toBe(37350)
  const beforeLate = snapshot()
  expect(() => staff.createSalary({ ...oldInput, user_id: actor })).toThrow(/закрито без проведення/)
  expect(snapshot()).toEqual(beforeLate)
  expect(pendingLocalRequests('salary:' + actor)).toEqual([])
  expect(db.prepare('SELECT work_date FROM salary_payments').all()).toEqual([{ work_date: '2026-10-01' }])
  validDatabase()
})

it('does not pay a daily-rate employee twice across midnight after a lost committed reply', async () => {
  db.prepare('UPDATE staff_users SET base_rate=12650 WHERE id=?').run(worker)
  failResolve = true
  const daily = () => ({ employee_id: worker, employee_name: 'Synthetic worker',
    method: 'cash' as const, fund_source: 'cashbox' as const, shift_id: shift, work_date: businessDateKey() })
  await expect(staffApi.dailyPayout(daily())).rejects.toThrow('LOST_COMMITTED_REPLY')
  expect(cash()).toBe(37350)
  vi.setSystemTime(new Date('2026-09-30T21:00:00Z'))
  reopen()
  const before = snapshot()
  failResolve = false
  await expect(staffApi.dailyPayout(daily())).rejects.toThrow(/вже.*збереж|вже.*проведен/i)
  expect(calls).toHaveLength(1)
  expect(cash()).toBe(37350)
  expect(snapshot()).toEqual(before)
  expect(pendingLocalRequests('daily-salary:' + actor)).toEqual([])
  expect(db.prepare('SELECT count(*) AS n FROM salary_payments').get()).toEqual({ n: 2 })
  expect(db.prepare('SELECT count(*) AS n FROM cash_operations').get()).toEqual({ n: 1 })
  validDatabase()
})

it('keeps a corrupt committed receipt unresolved even when the form payload is unchanged', async () => {
  failResolve = true
  const body = payload()
  await expect(staffApi.createSalary(body)).rejects.toThrow('LOST_COMMITTED_REPLY')
  const key = 'mutation:salary:' + tenant + ':' + calls[0].input.operation_id
  const row = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(key) as { value_json: string }
  const damaged = JSON.parse(row.value_json)
  damaged.result.amount = 1
  db.prepare('UPDATE app_meta SET value_json=? WHERE key=?').run(JSON.stringify(damaged), key)
  const before = snapshot(), pending = pendingLocalRequests('salary:' + actor)
  failResolve = false
  await expect(staffApi.createSalary(body)).rejects.toThrow(/Пошкоджений|підтвердити/)
  expect(calls).toHaveLength(1)
  expect(cash()).toBe(37350)
  expect(snapshot()).toEqual(before)
  expect(pendingLocalRequests('salary:' + actor)).toEqual(pending)
})

it('resolves the exact retained request without sending another financial command', async () => {
  failResolve = true
  const body = payload()
  await expect(staffApi.createSalary(body)).rejects.toThrow('LOST_COMMITTED_REPLY')
  reopen()
  const before = snapshot()
  failResolve = false
  expect((await staffApi.createSalary(body)).data).toEqual(results[0])
  expect(calls).toHaveLength(1)
  expect(snapshot()).toEqual(before)
  expect(pendingLocalRequests('salary:' + actor)).toEqual([])
})

it('preserves owner-funds cash accounting while recovering a daily payout on a later day', async () => {
  db.prepare('UPDATE staff_users SET base_rate=12650 WHERE id=?').run(worker)
  failResolve = true
  const daily = () => ({ employee_id: worker, employee_name: 'Synthetic worker',
    method: 'cash' as const, fund_source: 'owner_funds' as const, shift_id: shift, work_date: businessDateKey() })
  await expect(staffApi.dailyPayout(daily())).rejects.toThrow('LOST_COMMITTED_REPLY')
  expect(cash()).toBe(50000)
  vi.setSystemTime(new Date('2026-09-30T21:00:00Z'))
  reopen()
  const before = snapshot()
  failResolve = false
  await expect(staffApi.dailyPayout(daily())).rejects.toThrow(/вже.*збереж|вже.*проведен/i)
  expect(calls).toHaveLength(1)
  expect(cash()).toBe(50000)
  expect(snapshot()).toEqual(before)
  expect(pendingLocalRequests('daily-salary:' + actor)).toEqual([])
  validDatabase()
})
