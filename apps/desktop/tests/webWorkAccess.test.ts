import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'
import { WEB_ACCESS_PROBE, canWorkViaWeb, managerCanSell, setWebWorkAccess, webWorkAllowedIds } from '../src/security/managerSaleAccess'

// 23.11.2026 (план B3, рішення власника): «Працює через веб» — перемикач у картці касира на головному ПК.
describe('web work access (owner switch for cashiers)', () => {
  let root: string
  let db: LocalDatabase
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-web-work-'))
    db = new LocalDatabase(root)
    const now = new Date().toISOString()
    const insert = db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,phone,is_active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)')
    insert.run('owner-1', DEFAULT_TENANT_ID, 'Власник', 'owner', '+380000000000', now, now)
    insert.run('manager-1', DEFAULT_TENANT_ID, 'Менеджер', 'manager', '+380000000001', now, now)
    insert.run('cashier-1', DEFAULT_TENANT_ID, 'Касир', 'cashier', '+380000000002', now, now)
    insert.run('cashier-2', DEFAULT_TENANT_ID, 'Другий касир', 'cashier', '+380000000003', now, now)
    insert.run('tire-1', DEFAULT_TENANT_ID, 'Шиномонтажник', 'tire_worker', '+380000000004', now, now)
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

  it('owner, admin and manager work through the web by role; a cashier only after the switch', () => {
    for (const role of ['owner', 'admin', 'manager']) expect(canWorkViaWeb(db, 'anyone', role)).toBe(true)
    expect(canWorkViaWeb(db, 'cashier-1', 'cashier')).toBe(false)
    expect(setWebWorkAccess(db, 'cashier-1', true)).toEqual(['cashier-1'])
    expect(canWorkViaWeb(db, 'cashier-1', 'cashier')).toBe(true)
    // Дозвіл особистий: другий касир його не отримує.
    expect(canWorkViaWeb(db, 'cashier-2', 'cashier')).toBe(false)
    expect(webWorkAllowedIds(db)).toEqual(['cashier-1'])
    expect(setWebWorkAccess(db, 'cashier-1', false)).toEqual([])
    expect(canWorkViaWeb(db, 'cashier-1', 'cashier')).toBe(false)
  })

  it('the switch exists only for cashiers; other roles and broken ids are refused', () => {
    expect(() => setWebWorkAccess(db, 'manager-1', true)).toThrow('для касира')
    expect(() => setWebWorkAccess(db, 'tire-1', true)).toThrow('для касира')
    expect(() => setWebWorkAccess(db, 'missing', true)).toThrow('не знайдено')
    expect(() => setWebWorkAccess(db, "x' OR 1=1", true)).toThrow()
    expect(() => setWebWorkAccess(db, 'cashier-1', 'yes' as unknown as boolean)).toThrow()
  })

  it('a permission left from the cashier days gives nothing after the role changed, and never to other roles', () => {
    setWebWorkAccess(db, 'cashier-1', true)
    // Працівника перевели в шиномонтажники: старий запис у списку нічого не відкриває.
    expect(canWorkViaWeb(db, 'cashier-1', 'tire_worker')).toBe(false)
    expect(canWorkViaWeb(db, 'cashier-1', 'storekeeper')).toBe(false)
    expect(canWorkViaWeb(db, 'cashier-1', 'sto_viewer')).toBe(false)
  })

  it('web access is separate from the manager sale switch', () => {
    setWebWorkAccess(db, 'cashier-1', true)
    expect(managerCanSell(db, 'cashier-1')).toBe(false)
  })

  it('only the owner and the administrator flip the switch', () => {
    for (const channel of ['desktop:staff:web-access', 'desktop:staff:set-web-access']) {
      expect(isDesktopChannelAllowed(channel, 'owner')).toBe(true)
      expect(isDesktopChannelAllowed(channel, 'admin')).toBe(true)
      for (const role of ['manager', 'cashier', 'storekeeper', 'tire_worker']) expect(isDesktopChannelAllowed(channel, role)).toBe(false)
    }
  })

  it('the main PC decides: the question is answered before anything runs, and a cashier without the switch runs nothing', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    const executor = main.slice(main.indexOf('async function executeWebRequest('), main.indexOf('let outboxPusher'))
    const probe = executor.indexOf('if (channel === WEB_ACCESS_PROBE) return viaWeb')
    const refuse = executor.indexOf('if (!viaWeb) throw new Error(')
    const run = executor.indexOf('executeLanCommand(channel')
    expect(executor).toContain('const viaWeb = canWorkViaWeb(requireLocalDatabase(), session.id, session.role)')
    expect(probe).toBeGreaterThan(-1)
    expect(refuse).toBeGreaterThan(probe)
    expect(run).toBeGreaterThan(refuse)
    // Питання «чи можна мені» — не дія каси: окремого обробника немає, тож через нього нічого не виконати.
    expect(WEB_ACCESS_PROBE).toBe('desktop:access:web-work')
    expect(main).not.toContain("handleDesktopIpc('desktop:access:")
    expect(isDesktopChannelAllowed(WEB_ACCESS_PROBE, 'owner')).toBe(false)
  })
})
