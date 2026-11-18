import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalStaffRepository } from '../src/repositories/staffRepository'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { CatalogBatchRepository } from '../src/repositories/catalogBatchRepository'
import { PUBLIC_DESKTOP_CHANNELS } from '../src/security/desktopAuthorization'

describe('cashier login, quick goods and bulk price guard (16.11.2026)', () => {
  let root = ''
  let db: LocalDatabase
  let staff: LocalStaffRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-cashier-'))
    db = new LocalDatabase(root)
    staff = new LocalStaffRepository(db)
  })
  afterEach(() => {
    db.close()
    if (path.basename(root).startsWith('forsage-cashier-')) rmSync(root, { recursive: true, force: true })
  })

  const user = (id: string, phone: string, role: string, password: string, active = true) => staff.saveServerUser({
    id, phone, full_name: 'Працівник ' + id, role, is_active: active,
    created_at: '2026-11-16T08:00:00.000Z', updated_at: '2026-11-16T08:00:00.000Z',
  }, password)

  it('finds the cashier by password alone', () => {
    user('cashier-a', '+380671110001', 'cashier', 'anna-2026')
    user('cashier-b', '+380671110002', 'cashier', 'boris-2026')
    expect(staff.loginWithPasswordOnly('boris-2026')).toMatchObject({ id: 'cashier-b', phone: '+380671110002', role: 'cashier' })
    expect(staff.loginWithPasswordOnly('anna-2026').id).toBe('cashier-a')
    expect(() => staff.loginWithPasswordOnly('nobody')).toThrow('Невірний пароль')
  })

  it('lets owner and admin in by password alone, and refuses an ambiguous password', () => {
    user('owner', '+380671110009', 'owner', 'owner-secret')
    user('admin', '+380671110008', 'admin', 'admin-secret')
    user('tire', '+380671110007', 'tire_worker', 'tire-secret')
    user('cashier-a', '+380671110001', 'cashier', 'same-pass')
    user('manager-b', '+380671110002', 'manager', 'same-pass')
    user('cashier-off', '+380671110003', 'cashier', 'off-pass', false)
    expect(staff.loginWithPasswordOnly('owner-secret')).toMatchObject({ id: 'owner', role: 'owner' })
    expect(staff.loginWithPasswordOnly('admin-secret')).toMatchObject({ id: 'admin', role: 'admin' })
    expect(() => staff.loginWithPasswordOnly('tire-secret')).toThrow('Невірний пароль')
    expect(() => staff.loginWithPasswordOnly('same-pass')).toThrow('кілька працівників')
    expect(() => staff.loginWithPasswordOnly('off-pass')).toThrow('Невірний пароль')
    // Звичайний вхід з телефоном власника працює як раніше.
    expect(staff.loginWithPassword('+380671110009', 'owner-secret').role).toBe('owner')
  })

  it('blocks guessing after 10 wrong passwords', () => {
    user('cashier-a', '+380671110001', 'cashier', 'anna-2026')
    for (let i = 0; i < 9; i++) expect(() => staff.loginWithPasswordOnly('wrong-' + i)).toThrow('Невірний пароль')
    expect(() => staff.loginWithPasswordOnly('wrong-last')).toThrow('Забагато спроб')
    expect(() => staff.loginWithPasswordOnly('anna-2026')).toThrow('Забагато спроб')
  })

  it('the password-only channel is reachable before login like the phone login', () => {
    expect(PUBLIC_DESKTOP_CHANNELS.has('desktop:auth:login-password')).toBe(true)
  })

  it('lists only quick goods for the till gallery, beyond the first 200 cards', () => {
    db.transaction(() => {
      const insert = db.prepare(`INSERT INTO products (id, tenant_id, sku, name, qty_on_hand, retail_price, is_favorite, created_at, updated_at)
        VALUES (?, ?, ?, ?, 5, 1000, ?, '2026-01-01', '2026-01-01')`)
      for (let i = 0; i < 300; i++) insert.run('p' + String(i).padStart(3, '0'), DEFAULT_TENANT_ID, 'SKU-' + i, 'Товар ' + String(i).padStart(3, '0'), 0)
      insert.run('coffee', DEFAULT_TENANT_ID, 'COFFEE', 'Яяя кава американо', 1)
    })
    const catalog = new LocalCatalogRepository(db)
    const quick = catalog.listProducts({ favorites: true, limit: 500 })
    expect(quick.total).toBe(1)
    expect(quick.data.map(p => p.id)).toEqual(['coffee'])
    expect(catalog.listProducts({ limit: 500 }).total).toBe(301)
  })

  it('bulk price change never puts the sale price below purchase, but category moves still pass', () => {
    const catalog = new LocalCatalogRepository(db)
    db.prepare(`INSERT INTO products (id, tenant_id, sku, name, qty_on_hand, purchase_price, retail_price, created_at, updated_at)
      VALUES ('cheap', ?, 'C-1', 'Старий товар', 1, 10000, 9000, '2026-01-01', '2026-01-01'),
             ('ok', ?, 'C-2', 'Нормальний товар', 1, 10000, 15000, '2026-01-01', '2026-01-01')`).run(DEFAULT_TENANT_ID, DEFAULT_TENANT_ID)
    db.prepare(`INSERT INTO categories (id, tenant_id, name, created_at, updated_at) VALUES ('cat', ?, 'Фільтри', '2026-01-01', '2026-01-01')`).run(DEFAULT_TENANT_ID)
    const batch = new CatalogBatchRepository(db, catalog)
    expect(() => batch.apply({ operation_id: randomUUID(), kind: 'bulk', payload: { productIds: ['ok'], updates: { retail_price_action: { type: 'percent', value: -40 } } } }))
      .toThrow('нижчою за закупівельну')
    expect(catalog.findById('ok')!.retail_price).toBe(15000)
    // Стара «підозріла» ціна не заважає перенести картку в категорію.
    expect(batch.apply({ operation_id: randomUUID(), kind: 'bulk', payload: { productIds: ['cheap', 'ok'], updates: { category_id: 'cat' } } })).toEqual({ updated: 2 })
    expect(batch.apply({ operation_id: randomUUID(), kind: 'bulk', payload: { productIds: ['cheap'], updates: { retail_price_action: { type: 'markup', value: 30 } } } })).toEqual({ updated: 1 })
    expect(catalog.findById('cheap')!.retail_price).toBe(13000)
  })
})
