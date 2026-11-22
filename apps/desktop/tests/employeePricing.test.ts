import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'
import { employeePricing, setEmployeePricing } from '../src/security/employeePricing'

describe('employee price in the staff card (owner decision 22.11.2026)', () => {
  let root: string
  let db: LocalDatabase
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-employee-price-'))
    db = new LocalDatabase(root)
    const now = new Date().toISOString()
    const insert = db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,phone,is_active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)')
    insert.run('manager-1', DEFAULT_TENANT_ID, 'Менеджер', 'manager', '+380000000001', now, now)
    insert.run('cashier-1', DEFAULT_TENANT_ID, 'Касир', 'cashier', '+380000000002', now, now)
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

  it('is empty by default; stores a percent or «at cost» per employee and removes it again', () => {
    expect(employeePricing(db)).toEqual({})
    expect(setEmployeePricing(db, 'manager-1', { mode: 'pct', pct: 12.345 })).toEqual({ 'manager-1': { mode: 'pct', pct: 12.35 } })
    expect(setEmployeePricing(db, 'cashier-1', { mode: 'cost', pct: 55 })).toEqual({ 'manager-1': { mode: 'pct', pct: 12.35 }, 'cashier-1': { mode: 'cost' } })
    expect(setEmployeePricing(db, 'manager-1', { mode: 'pct', pct: 0 })['manager-1']).toEqual({ mode: 'pct', pct: 0 })
    expect(setEmployeePricing(db, 'manager-1', null)).toEqual({ 'cashier-1': { mode: 'cost' } })
    expect(employeePricing(db)).toEqual({ 'cashier-1': { mode: 'cost' } })
  })

  it('refuses broken values, unknown employees and never keeps a damaged record', () => {
    for (const bad of [{ mode: 'pct', pct: 101 }, { mode: 'pct', pct: -1 }, { mode: 'pct', pct: 'x' }, { mode: 'free' }, {}, 'cost', undefined])
      expect(() => setEmployeePricing(db, 'manager-1', bad), JSON.stringify(bad)).toThrow('від 0 до 100')
    expect(() => setEmployeePricing(db, 'missing', { mode: 'cost' })).toThrow('не знайдено')
    expect(() => setEmployeePricing(db, "x' OR 1=1", { mode: 'cost' })).toThrow('Некоректний працівник')
    expect(employeePricing(db)).toEqual({})
    db.prepare("INSERT INTO app_meta(key,value_json,updated_at) VALUES('employee-pricing:v1',?,?)")
      .run(JSON.stringify({ users: { 'manager-1': { mode: 'pct', pct: 500 }, 'cashier-1': { mode: 'cost' }, 'bad id!': { mode: 'cost' } } }), new Date().toISOString())
    expect(employeePricing(db)).toEqual({ 'cashier-1': { mode: 'cost' } })
  })

  it('only the owner and administrator may read or change the setting; the till gets prices with the staff list', () => {
    for (const channel of ['desktop:staff:employee-pricing', 'desktop:staff:set-employee-pricing']) {
      expect(isDesktopChannelAllowed(channel, 'owner')).toBe(true)
      for (const role of ['manager', 'cashier'] as const) expect(isDesktopChannelAllowed(channel, role), channel + ' ' + role).toBe(false)
    }
    expect(isDesktopChannelAllowed('desktop:catalog:list-staff', 'cashier')).toBe(true)
  })
})
