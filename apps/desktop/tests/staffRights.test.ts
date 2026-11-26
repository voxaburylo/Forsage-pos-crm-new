import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'
import { allStaffRights, effectiveStaffRights, setStaffRight, WRITEOFF_CREATE_CHANNELS } from '../src/security/staffRights'
import { webRpcChannelAllowed } from '../src/lan/webRpcChannels'

// 24.11.2026 (рішення власника): права працівника — перемикачами в його картці; зберігає головний ПК.
describe('staff rights switched on by the owner', () => {
  let root: string
  let db: LocalDatabase
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-staff-rights-'))
    db = new LocalDatabase(root)
    const now = new Date().toISOString()
    const insert = db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,phone,is_active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)')
    insert.run('owner-1', DEFAULT_TENANT_ID, 'Власник', 'owner', '+380000000000', now, now)
    insert.run('manager-1', DEFAULT_TENANT_ID, 'Менеджер', 'manager', '+380000000001', now, now)
    insert.run('cashier-1', DEFAULT_TENANT_ID, 'Касир', 'cashier', '+380000000002', now, now)
    insert.run('cashier-2', DEFAULT_TENANT_ID, 'Другий касир', 'cashier', '+380000000003', now, now)
    insert.run('store-1', DEFAULT_TENANT_ID, 'Комірник', 'storekeeper', '+380000000004', now, now)
    insert.run('tire-1', DEFAULT_TENANT_ID, 'Шиномонтажник', 'tire_worker', '+380000000005', now, now)
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

  it('without switches every role keeps exactly what it had before', () => {
    expect(effectiveStaffRights(db, 'owner-1', 'owner')).toEqual({ orders: true, purchase_prices: true, reports: true, writeoffs: true })
    expect(effectiveStaffRights(db, 'manager-1', 'manager')).toEqual({ orders: true, purchase_prices: false, reports: true, writeoffs: false })
    expect(effectiveStaffRights(db, 'cashier-1', 'cashier')).toEqual({ orders: false, purchase_prices: false, reports: false, writeoffs: false })
    expect(effectiveStaffRights(db, 'store-1', 'storekeeper')).toEqual({ orders: false, purchase_prices: true, reports: false, writeoffs: true })
    expect(effectiveStaffRights(db, 'tire-1', 'tire_worker')).toEqual({ orders: false, purchase_prices: false, reports: false, writeoffs: false })
  })

  it('a switch adds the right to this employee only, survives a reread, and can be turned off', () => {
    expect(setStaffRight(db, 'cashier-1', 'orders', true)).toEqual({ orders: true, purchase_prices: false, reports: false, writeoffs: false })
    expect(setStaffRight(db, 'cashier-1', 'reports', true)).toEqual({ orders: true, purchase_prices: false, reports: true, writeoffs: false })
    expect(effectiveStaffRights(db, 'cashier-2', 'cashier').orders).toBe(false)
    expect(allStaffRights(db)['cashier-1']).toEqual({ orders: true, purchase_prices: false, reports: true, writeoffs: false })
    expect(allStaffRights(db)['manager-1'].purchase_prices).toBe(false)
    expect(setStaffRight(db, 'manager-1', 'purchase_prices', true).purchase_prices).toBe(true)
    expect(setStaffRight(db, 'cashier-1', 'orders', false)).toEqual({ orders: false, purchase_prices: false, reports: true, writeoffs: false })
    expect(setStaffRight(db, 'cashier-1', 'reports', false)).toEqual({ orders: false, purchase_prices: false, reports: false, writeoffs: false })
  })

  it('a stored switch stops working when the role no longer allows it', () => {
    setStaffRight(db, 'cashier-1', 'reports', true)
    // Працівника перевели в комірники: «Бачить звіти» для комірника не вмикається — право не діє.
    expect(effectiveStaffRights(db, 'cashier-1', 'storekeeper').reports).toBe(false)
    expect(effectiveStaffRights(db, 'cashier-1', 'tire_worker')).toEqual({ orders: false, purchase_prices: false, reports: false, writeoffs: false })
  })

  it('refuses a wrong employee, a wrong right, a role that already has it and a role it does not fit', () => {
    expect(() => setStaffRight(db, 'missing', 'orders', true)).toThrow('Працівника не знайдено')
    expect(() => setStaffRight(db, 'cashier-1', 'sell', true)).toThrow('Некоректне право')
    expect(() => setStaffRight(db, 'cashier-1', 'orders', 'yes')).toThrow('Некоректне значення')
    expect(() => setStaffRight(db, 'manager-1', 'orders', true)).toThrow('уже має за своєю роллю')
    expect(() => setStaffRight(db, 'tire-1', 'orders', true)).toThrow('не вмикається')
    expect(() => setStaffRight(db, 'store-1', 'reports', true)).toThrow('не вмикається')
    expect(() => setStaffRight(db, "x' OR 1=1", 'orders', true)).toThrow('Некоректний працівник')
  })

  // 26.11.2026, власник: «зробити доступ до списання в картці менеджера».
  it('write-off: the owner switches it on for the manager only; the main PC refuses a manager write-off without it', () => {
    expect(effectiveStaffRights(db, 'manager-1', 'manager').writeoffs).toBe(false)
    expect(setStaffRight(db, 'manager-1', 'writeoffs', true).writeoffs).toBe(true)
    expect(effectiveStaffRights(db, 'manager-1', 'manager').writeoffs).toBe(true)
    expect(() => setStaffRight(db, 'cashier-1', 'writeoffs', true)).toThrow('не вмикається')
    expect(() => setStaffRight(db, 'store-1', 'writeoffs', true)).toThrow('уже має за своєю роллю')
    expect(WRITEOFF_CREATE_CHANNELS.has('desktop:warehouse:create-writeoff')).toBe(true)
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main).toContain("session.role === 'manager' && WRITEOFF_CREATE_CHANNELS.has(channel)")
    expect(main).toContain('.writeoffs) {')
  })

  it('damaged stored data never grants anything', () => {
    const now = new Date().toISOString()
    for (const value of ['not json', '{"users":[]}', '{"users":{"cashier-1":{"orders":"yes","reports":1}}}', '{"users":{"cashier-1":null}}']) {
      db.prepare(`INSERT INTO app_meta(key,value_json,updated_at) VALUES('staff-rights:v1',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`).run(value, now)
      expect(effectiveStaffRights(db, 'cashier-1', 'cashier')).toEqual({ orders: false, purchase_prices: false, reports: false, writeoffs: false })
    }
  })

  it('only the owner changes rights; everyone signed in may read their own; the web reaches them through the main PC', () => {
    for (const channel of ['desktop:staff:rights', 'desktop:staff:set-right']) {
      for (const role of ['owner', 'admin']) expect(isDesktopChannelAllowed(channel, role)).toBe(true)
      for (const role of ['manager', 'cashier', 'storekeeper', 'sto_viewer', 'tire_worker']) expect(isDesktopChannelAllowed(channel, role)).toBe(false)
    }
    for (const role of ['owner', 'admin', 'manager', 'cashier', 'storekeeper', 'sto_viewer']) expect(isDesktopChannelAllowed('desktop:staff:my-rights', role)).toBe(true)
    for (const channel of ['desktop:staff:rights', 'desktop:staff:set-right', 'desktop:staff:my-rights']) expect(webRpcChannelAllowed(channel)).toBe(true)
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    // Свої права — лише того, хто увійшов: ідентифікатор не береться з аргументів.
    expect(main).toContain("handleDesktopIpc('desktop:staff:my-rights', () => {\n    const session = requireDesktopSession()\n    return effectiveStaffRights(requireLocalDatabase(), session.id, session.role)")
  })
})
