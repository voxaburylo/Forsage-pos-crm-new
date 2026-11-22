import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { isDesktopChannelAllowed, isManagerDepositChannel, isManagerSaleChannel } from '../src/security/desktopAuthorization'
import { managerCanSell, managerCanTakeDeposit, managerDepositAllowedIds, managerSaleAllowedIds, setManagerDepositAccess, setManagerSaleAccess } from '../src/security/managerSaleAccess'

describe('manager sale access (owner switch)', () => {
  let root: string
  let db: LocalDatabase
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-manager-sale-'))
    db = new LocalDatabase(root)
    const now = new Date().toISOString()
    const insert = db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,phone,is_active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)')
    insert.run('manager-1', DEFAULT_TENANT_ID, 'Менеджер', 'manager', '+380000000001', now, now)
    insert.run('cashier-1', DEFAULT_TENANT_ID, 'Касир', 'cashier', '+380000000002', now, now)
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

  it('is off by default and toggles only for managers', () => {
    expect(managerCanSell(db, 'manager-1')).toBe(false)
    expect(setManagerSaleAccess(db, 'manager-1', true)).toEqual(['manager-1'])
    expect(managerCanSell(db, 'manager-1')).toBe(true)
    expect(managerSaleAllowedIds(db)).toEqual(['manager-1'])
    expect(setManagerSaleAccess(db, 'manager-1', false)).toEqual([])
    expect(managerCanSell(db, 'manager-1')).toBe(false)
    expect(() => setManagerSaleAccess(db, 'cashier-1', true)).toThrow('лише менеджеру')
    expect(() => setManagerSaleAccess(db, 'missing', true)).toThrow('не знайдено')
    expect(() => setManagerSaleAccess(db, "x' OR 1=1", true)).toThrow()
  })

  it('has a separate «may take deposits» switch that opens only the own shift and order payments (owner decision 22.11.2026)', () => {
    expect(managerCanTakeDeposit(db, 'manager-1')).toBe(false)
    expect(setManagerDepositAccess(db, 'manager-1', true)).toEqual(['manager-1'])
    expect(managerCanTakeDeposit(db, 'manager-1')).toBe(true)
    // Два дозволи незалежні: задаток не вмикає продаж.
    expect(managerCanSell(db, 'manager-1')).toBe(false)
    expect(managerSaleAllowedIds(db)).toEqual([])
    expect(managerDepositAllowedIds(db)).toEqual(['manager-1'])
    expect(() => setManagerDepositAccess(db, 'cashier-1', true)).toThrow('лише менеджеру')
    expect(() => setManagerDepositAccess(db, 'missing', true)).toThrow('не знайдено')
    expect(setManagerDepositAccess(db, 'manager-1', false)).toEqual([])
    for (const channel of ['desktop:pos:open-shift', 'desktop:pos:close-shift', 'desktop:orders:add-payment']) {
      expect(isManagerDepositChannel(channel), channel).toBe(true)
      expect(isManagerSaleChannel(channel), channel).toBe(true)
    }
    // Продаж, повернення, касові операції, видача й ПРРО задатком не відкриваються.
    for (const channel of ['desktop:pos:checkout', 'desktop:pos:create-return', 'desktop:pos:create-cash-operation', 'desktop:pos:pay-debt',
      'desktop:orders:complete', 'desktop:fiscal:print-x-report']) expect(isManagerDepositChannel(channel), channel).toBe(false)
    for (const channel of ['desktop:staff:deposit-access', 'desktop:staff:set-deposit-access']) {
      expect(isDesktopChannelAllowed(channel, 'owner')).toBe(true)
      expect(isDesktopChannelAllowed(channel, 'manager')).toBe(false)
    }
    const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    const execute = source.slice(source.indexOf('async function executeDesktopCommand'))
    expect(execute).toContain('if (!(depositOnly && isManagerDepositChannel(channel))) throw new Error(depositOnly ? MANAGER_DEPOSIT_ONLY : MANAGER_SALE_DENIED)')
  })

  it('lets the manager role reach till channels, which the main PC then gates by the switch', () => {
    for (const channel of ['desktop:pos:checkout', 'desktop:pos:open-shift', 'desktop:pos:close-shift', 'desktop:orders:add-payment', 'desktop:fiscal:print-x-report']) {
      expect(isDesktopChannelAllowed(channel, 'manager')).toBe(true)
      expect(isManagerSaleChannel(channel)).toBe(true)
    }
    for (const channel of ['desktop:pos:list-open-shifts', 'desktop:fiscal:status', 'desktop:supply:commit-receiving', 'desktop:inventory:complete']) {
      expect(isManagerSaleChannel(channel)).toBe(false)
    }
    expect(isDesktopChannelAllowed('desktop:staff:set-sale-access', 'manager')).toBe(false)
    expect(isDesktopChannelAllowed('desktop:staff:set-sale-access', 'owner')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:fiscal:set-config', 'manager')).toBe(false)
    expect(isDesktopChannelAllowed('desktop:pos:checkout', 'storekeeper')).toBe(false)
  })

  it('checks the switch in the one place every local and LAN command passes', () => {
    const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    const execute = source.slice(source.indexOf('async function executeDesktopCommand'))
    expect(execute.indexOf('managerCanSell(requireLocalDatabase(), session.id)')).toBeGreaterThan(0)
    expect(execute.indexOf('managerCanSell(')).toBeLessThan(execute.indexOf('const run = () =>'))
  })

  it('closes a shift from the web only with the authority of an active owner/admin of this till', () => {
    for (const channel of ['desktop:pos:remote-shifts', 'desktop:pos:remote-close-shift']) {
      expect(isDesktopChannelAllowed(channel, 'cashier')).toBe(true)
      expect(isDesktopChannelAllowed(channel, 'storekeeper')).toBe(false)
      expect(isManagerSaleChannel(channel)).toBe(false)
    }
    const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    const actor = source.slice(source.indexOf('const remoteShiftActor'), source.indexOf("handleDesktopIpc('desktop:pos:list-open-shifts'"))
    expect(actor).toContain("actor.role !== 'owner' && actor.role !== 'admin'")
    expect(actor).toContain('activeSession(requireLocalDatabase()')
    expect(actor).toContain('closeShift(String(input?.cashier_id')
    expect(actor).toContain('actor.role, actor.id)')
  })
})
