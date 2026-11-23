import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { NIGHTLY_CODES, STALE_SHIFT_HOURS, nightlyCheckDue, runNightlyCheck } from '../src/diagnostics/nightlyCheck'
import { nightlyCheckTick, performNightlyCheck, readNightlySummary } from '../src/diagnostics/nightlyCheckRunner'

// 23.11.2026 (план T6): нічна перевірка бази каси — лише читає, знайдене йде в журнал проблем.
describe('nightly check of the till database', () => {
  let root: string
  let db: LocalDatabase
  const now = new Date('2026-11-24T03:10:00')
  const iso = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString()

  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-nightly-')); db = new LocalDatabase(root) })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

  function product(id: string, qty: number) {
    db.prepare(`INSERT INTO products(id,tenant_id,sku,name,retail_price,qty_on_hand,created_at,updated_at) VALUES(?,?,?,?,100,?,?,?)`).run(id, tenant, 'SKU-' + id, 'Товар ' + id, qty, iso(900), iso(900))
  }
  function movement(id: string, productId: string, delta: number, after: number, hoursAgo: number, deleted = false) {
    db.prepare(`INSERT INTO inventory_movements(id,tenant_id,product_id,source_type,qty_delta,qty_after,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(id, tenant, productId, 'inventory', delta, after, iso(hoursAgo), iso(hoursAgo), deleted ? iso(hoursAgo) : null)
  }
  function shift(id: string, openedHoursAgo: number, closed = false) {
    db.prepare(`INSERT INTO shifts(id,tenant_id,cashier_id,status,opened_at,closed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, tenant, 'cashier-1', closed ? 'closed' : 'open', iso(openedHoursAgo), closed ? iso(openedHoursAgo - 8) : null, iso(openedHoursAgo), iso(openedHoursAgo))
  }
  const check = () => runNightlyCheck(db, { now: () => now })

  it('a healthy database gives no findings', () => {
    product('a', 5); movement('m1', 'a', 5, 5, 10)
    product('never-moved', 3) // товар без жодного руху не порівнюється — порівнювати нема з чим
    shift('today', 10); shift('old-closed', 200, true)
    const result = check()
    expect(result.findings).toEqual([])
    expect(result.checked_at).toBe(now.toISOString())
  })

  it('stock on the card that differs from the last stock movement is reported, with the true number of goods', () => {
    product('ok', 4); movement('m-ok-1', 'ok', 10, 10, 50); movement('m-ok-2', 'ok', -6, 4, 20)
    // Ревізія записала «стало 51», а в картці лишився 0 — як у справжній базі 23.11.2026.
    product('lost', 0); movement('m-lost-1', 'lost', -51, 0, 3000); movement('m-lost-2', 'lost', 51, 51, 2000)
    // Видалений рух не рахується: останнім чинним лишається попередній.
    product('undone', 7); movement('m-u-1', 'undone', 7, 7, 40); movement('m-u-2', 'undone', 3, 10, 30, true)
    for (let index = 0; index < 8; index++) { product('x' + index, 1); movement('mx' + index, 'x' + index, 2, 2, 5) }
    const finding = check().findings.find(item => item.code === 'nightly-stock-ledger')!
    expect(finding.count).toBe(9)
    expect(finding.severity).toBe('warning')
    // У приклади — найбільші розбіжності; повний список не вивалюється в журнал.
    expect(finding.detail).toContain('SKU-lost: у картці 0, за рухом 51')
    expect(finding.detail.match(/у картці/g)).toHaveLength(5)
    expect(finding.detail).toContain('нічого не виправляє сама')
  })

  it('a shift left open for more than a day and a half is reported; today’s shift is not', () => {
    shift('forgotten', STALE_SHIFT_HOURS + 5); shift('today', 6)
    const findings = check().findings
    expect(findings.map(item => item.code)).toEqual(['nightly-stale-shift'])
    expect(findings[0].count).toBe(1)
  })

  it('never changes shop data: the same check twice gives the same answer and the same rows', () => {
    product('lost', 0); movement('m1', 'lost', 5, 5, 100)
    const before = db.prepare('SELECT qty_on_hand, updated_at FROM products').all()
    const first = check(); const second = check()
    expect(second.findings).toEqual(first.findings)
    expect(db.prepare('SELECT qty_on_hand, updated_at FROM products').all()).toEqual(before)
    const source = readFileSync(new URL('../src/diagnostics/nightlyCheck.ts', import.meta.url), 'utf8')
    for (const write of ['UPDATE ', 'INSERT ', 'DELETE ']) expect(source).not.toContain(write)
  })

  it('findings go to the problem log; what is no longer found is closed; the result is remembered', () => {
    product('lost', 0); movement('m1', 'lost', 5, 5, 100)
    const record = vi.fn(); const resolveCode = vi.fn()
    performNightlyCheck(db, { record, resolveCode, now: () => now })
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0]).toMatchObject({ source: 'database', code: 'nightly-stock-ledger', severity: 'warning', context: { count: 1 } })
    expect(resolveCode.mock.calls.map(call => call[0]).sort()).toEqual(NIGHTLY_CODES.filter(code => code !== 'nightly-stock-ledger').sort())
    expect(readNightlySummary(db)).toEqual({ checked_at: now.toISOString(), findings: [{ code: 'nightly-stock-ledger', title: 'Залишок не збігається з рухом товару', count: 1 }] })
    // Розбіжність усунули (ревізія) — наступна перевірка закриває запис у журналі.
    db.prepare('UPDATE products SET qty_on_hand = 5 WHERE id = ?').run('lost')
    record.mockClear(); resolveCode.mockClear()
    performNightlyCheck(db, { record, resolveCode, now: () => new Date(now.getTime() + 86_400_000) })
    expect(record).not.toHaveBeenCalled()
    expect(resolveCode).toHaveBeenCalledWith('nightly-stock-ledger')
    expect(readNightlySummary(db)!.findings).toEqual([])
  })

  it('runs at night once a day; if the program was off at night — at the first chance next day', () => {
    const at = (text: string) => new Date(text)
    expect(nightlyCheckDue(null, at('2026-11-24T14:00:00'))).toBe(true)
    const lastNight = at('2026-11-23T03:00:00').toISOString()
    expect(nightlyCheckDue(lastNight, at('2026-11-23T15:00:00'))).toBe(false)
    expect(nightlyCheckDue(lastNight, at('2026-11-24T01:30:00'))).toBe(false)
    expect(nightlyCheckDue(lastNight, at('2026-11-24T03:05:00'))).toBe(true)
    // Уночі комп'ютер був вимкнений: вдень, щойно мине 30 годин.
    expect(nightlyCheckDue(lastNight, at('2026-11-24T08:00:00'))).toBe(false)
    expect(nightlyCheckDue(lastNight, at('2026-11-24T09:30:00'))).toBe(true)
    expect(nightlyCheckDue('garbage', at('2026-11-24T14:00:00'))).toBe(true)
  })

  it('the timer tick checks only when it is time', () => {
    const run = vi.fn(runNightlyCheck)
    const deps = { record: vi.fn(), resolveCode: vi.fn(), now: () => now, check: run }
    expect(nightlyCheckTick(db, deps)).not.toBeNull()
    expect(nightlyCheckTick(db, { ...deps, now: () => new Date(now.getTime() + 30 * 60_000) })).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('only the main PC checks, and the result reaches the owner through «Стан системи»', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main).toContain('if (!localDatabase || !isMainTill() || databaseMaintenance) return')
    expect(main).toContain('nightlyCheckTick(localDatabase, { record: recordDesktopProblem')
    expect(main).toContain('check: attempt(() => readNightlySummary(db)),')
  })
})
