import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { customerWritePayload } from '../src/security/customerWritePolicy'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'

describe('customer card integrity', () => {
  let root: string
  let db: LocalDatabase
  let pos: LocalPosRepository
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-customer-card-')); db = new LocalDatabase(root); pos = new LocalPosRepository(db) })
  afterEach(() => { db.close(); if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-customer-card-')) rmSync(root, { recursive: true, force: true }) })
  const create = () => pos.saveCustomer({ phone: '+38 (050) 123-45-67', full_name: 'ЄВГЕН Коваль', card_barcode: 'CARD123' }).data

  it('preserves personal discount and cashback mode on create, edit and every card read', () => {
    const first = pos.saveCustomer({ phone: '0508888888', discount_pct: 7.25, loyalty_mode: 'cashback', card_barcode: 'LOYALTY' }).data
    expect(first).toMatchObject({ discount_pct: 7.25, loyalty_mode: 'cashback' })
    for (const card of [pos.getCustomer(first.id), pos.findCustomerByBarcode('LOYALTY'), pos.listCustomers().data[0]]) {
      expect(card).toMatchObject({ discount_pct: 7.25, loyalty_mode: 'cashback' })
    }
    const saved = pos.saveCustomer({ discount_pct: 5, loyalty_mode: 'discount', expected_updated_at: first.updated_at }, first.id).data
    expect(saved).toMatchObject({ discount_pct: 5, loyalty_mode: 'discount' })
    expect(pos.getCustomer(first.id)).toMatchObject({ discount_pct: 5, loyalty_mode: 'discount' })
    expect(db.prepare('SELECT count(*) n FROM sales').get()).toMatchObject({ n: 0 })
  })
  it('persists a cashier discount through the write policy and rejects invalid percentages', () => {
    const customer = create()
    const session = { id: 'cashier', role: 'cashier' }
    const saved = pos.saveCustomer(customerWritePayload({ discount_pct: 7.5, expected_updated_at: customer.updated_at }, session, pos.getCustomer(customer.id)), customer.id).data
    expect(saved.discount_pct).toBe(7.5)
    expect(pos.getCustomer(customer.id).discount_pct).toBe(7.5)
    expect(pos.findCustomerByBarcode('CARD123')?.discount_pct).toBe(7.5)
    for (const value of [-1, 101]) {
      expect(() => pos.saveCustomer(customerWritePayload({ discount_pct: value }, session, pos.getCustomer(customer.id)), customer.id)).toThrow()
      expect(pos.getCustomer(customer.id).discount_pct).toBe(7.5)
    }
    expect(db.prepare('SELECT count(*) n FROM sales').get()).toMatchObject({ n: 0 })
    expect(db.prepare('SELECT count(*) n FROM bonus_transactions').get()).toMatchObject({ n: 0 })
  })
  it('cashier can create and change customer status without changing balances', () => {
    const session = { id: 'cashier', role: 'cashier' }
    const customer = pos.saveCustomer(customerWritePayload({ phone: '0501234567', client_status: 'sto' }, session)).data
    expect(customer.client_status).toBe('sto')
    for (const status of ['client', 'sto']) {
      pos.saveCustomer(customerWritePayload({ client_status: status }, session, pos.getCustomer(customer.id)), customer.id)
      expect(pos.getCustomer(customer.id)).toMatchObject({ client_status: status, bonus_balance: 0, debt_balance: 0, deposit_balance: 0 })
    }
    expect(() => pos.saveCustomer(customerWritePayload({ client_status: 'owner' }, session), customer.id)).toThrow('статус')
    expect(pos.getCustomer(customer.id).client_status).toBe('sto')
    expect(() => customerWritePayload({ client_status: 'sto' }, { id: 'worker', role: 'tire_worker' })).toThrow('Немає прав')
  })
  it('returns the configured price group and falls back when that group was removed', () => {
    const customer = create()
    db.prepare("INSERT OR REPLACE INTO app_meta(key,value_json,updated_at) VALUES('shop_settings',?,'2026-09-14')").run(JSON.stringify({price_tiers:[{id:'trade',name:'Trade',discount_pct:10}]}))
    pos.saveCustomer({ price_tier_id: 'trade', discount_pct: 5 }, customer.id)
    expect(pos.getCustomer(customer.id).price_tier).toMatchObject({ id: 'trade', discount_pct: 10 })
    db.prepare("UPDATE app_meta SET value_json='{}' WHERE key='shop_settings'").run()
    expect(pos.getCustomer(customer.id)).toMatchObject({ price_tier: null, discount_pct: 5 })
  })
  it('searches Cyrillic without case sensitivity in the list and cash desk', () => {
    const customer = create()
    for (const search of ['євген', 'КОВАЛЬ', '0501234567', '+380501234567', 'card123']) {
      expect(pos.listCustomers({ search }).data.map((c: any) => c.id)).toEqual([customer.id])
      expect(pos.searchCustomers({ search }).map((c) => c.id)).toEqual([customer.id])
    }
  })
  it('reuses a formatted phone without overwriting the existing card', () => {
    const customer = create()
    const result = pos.saveCustomer({ phone: '0501234567', full_name: 'Wrong name' })
    expect(result.meta?.reused).toBe(true)
    expect(result.data.id).toBe(customer.id)
    expect(result.data.full_name).toBe('ЄВГЕН Коваль')
  })
  it('rejects another customer phone and barcode on editing', () => {
    create()
    const second = pos.saveCustomer({ phone: '0507654321', full_name: 'Інший' }).data
    expect(() => pos.saveCustomer({ phone: '0501234567' }, second.id)).toThrow('таким телефоном')
    expect(() => pos.saveCustomer({ card_barcode: 'CARD123' }, second.id)).toThrow('іншому клієнту')
    expect(pos.getCustomer(second.id).phone).toBe('0507654321')
  })
  it('saves a pre-existing physical card for a new client, preserving leading zeros', () => {
    const card = pos.saveCustomer(customerWritePayload({ phone: '0501234567', card_barcode: ' 00012 345\r\n' }, { id: 'cashier', role: 'cashier' })).data
    expect(card.card_barcode).toBe('00012345')
    expect(pos.findCustomerByBarcode(' 00012 345\r\n')?.id).toBe(card.id)
    expect(isDesktopChannelAllowed('desktop:pos:save-customer', 'cashier')).toBe(true)
  })
  it('attaches a physical card to a phone match without replacing other profile fields', () => {
    const old = pos.saveCustomer({ phone: '+38 (050) 123-45-67', full_name: 'Коваль', discount_pct: 7 }).data
    const result = pos.saveCustomer({ phone: '0501234567', full_name: 'Не замінювати', discount_pct: 0, card_barcode: '000123' })
    expect(result.meta).toMatchObject({ reused: true, card_attached: true })
    expect(result.data).toMatchObject({ id: old.id, full_name: 'Коваль', discount_pct: 7, card_barcode: '000123' })
    expect(result.data.updated_at > old.updated_at).toBe(true)
    expect(db.prepare('SELECT count(*) n FROM customers').get()).toEqual({ n: 1 })
    expect(pos.findCustomerByBarcode('000123')?.id).toBe(old.id)
    const updates = db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type = 'customer.updated'").all() as Array<{ payload_json: string }>
    expect(updates).toHaveLength(1)
    expect(JSON.parse(updates[0].payload_json)).toMatchObject({ id: old.id, card_barcode: '000123' })
    const again = pos.saveCustomer({ phone: '0501234567', card_barcode: '000123' })
    expect(again.meta).toMatchObject({ reused: true, card_attached: false })
    expect(again.data.updated_at).toBe(result.data.updated_at)
  })
  it.each([undefined, null, '', '  '])('does not erase a card when reusing a phone with empty code %s', (barcode) => {
    const old = create()
    expect(pos.saveCustomer({ phone: '0501234567', card_barcode: barcode }).data.card_barcode).toBe(old.card_barcode)
  })
  it('does not silently replace an existing card via new-client creation', () => {
    const old = create()
    const before = db.prepare('SELECT count(*) n FROM sync_outbox').get()
    expect(() => pos.saveCustomer({ phone: '0501234567', card_barcode: 'OTHER', vehicle: { brand: 'VW', model: 'Golf' } })).toThrow('інша картка')
    expect(pos.getCustomer(old.id).card_barcode).toBe('CARD123')
    expect(db.prepare('SELECT count(*) n FROM customer_vehicles').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT count(*) n FROM sync_outbox').get()).toEqual(before)
  })
  it('rejects another client card both for a new phone and a reused phone', () => {
    create()
    const second = pos.saveCustomer({ phone: '0507654321' }).data
    for (const phone of ['0501111111', '0507654321']) {
      expect(() => pos.saveCustomer({ phone, card_barcode: ' CARD123\r\n', vehicle: { brand: 'VW', model: 'Golf' } })).toThrow('іншому клієнту')
    }
    expect(pos.getCustomer(second.id).card_barcode).toBeNull()
    expect(db.prepare('SELECT count(*) n FROM customers').get()).toEqual({ n: 2 })
    expect(db.prepare('SELECT count(*) n FROM customer_vehicles').get()).toEqual({ n: 0 })
  })
  it('rolls back card attachment and outbox if vehicle creation fails', () => {
    const old = pos.saveCustomer({ phone: '0501234567' }).data
    const before = db.prepare('SELECT count(*) n FROM sync_outbox').get()
    db.prepare("CREATE TRIGGER reject_test_vehicle BEFORE INSERT ON customer_vehicles BEGIN SELECT RAISE(ABORT, 'test vehicle failure'); END").run()
    expect(() => pos.saveCustomer({ phone: '0501234567', card_barcode: '000123', vehicle: { brand: 'VW', model: 'Golf' } })).toThrow('test vehicle failure')
    expect(pos.getCustomer(old.id)).toMatchObject({ card_barcode: null, updated_at: old.updated_at })
    expect(db.prepare('SELECT count(*) n FROM sync_outbox').get()).toEqual(before)
  })
  it('allows deliberate cashier replacement in the editor with version checking', () => {
    const old = create()
    const payload = customerWritePayload({ card_barcode: '000009', expected_updated_at: old.updated_at }, { id: 'cashier', role: 'cashier' }, old)
    expect(pos.saveCustomer(payload, old.id).data.card_barcode).toBe('000009')
    expect(pos.findCustomerByBarcode('CARD123')).toBeNull()
    expect(pos.findCustomerByBarcode('000009')?.id).toBe(old.id)
    expect(() => pos.saveCustomer({ card_barcode: 'STALE', expected_updated_at: old.updated_at }, old.id)).toThrow('вже змінено')
  })
  it('rejects a stale card and does not partially save contact data or bonuses', () => {
    const old = create()
    pos.saveCustomer({ bonus_balance: 500 }, old.id)
    expect(() => pos.saveCustomer({ full_name: 'Stale edit', bonus_balance: 900, expected_updated_at: old.updated_at }, old.id)).toThrow('вже змінено')
    expect(pos.getCustomer(old.id)).toMatchObject({ full_name: old.full_name, bonus_balance: 500 })
  })
  it('guards bonus corrections independently of the profile timestamp', () => {
    const old = create()
    pos.saveCustomer({ bonus_balance: 500 }, old.id)
    const count = db.prepare('SELECT count(*) n FROM sync_outbox').get()
    expect(() => pos.saveCustomer({ full_name: 'Stale', bonus_balance: 900, expected_bonus_balance: 0 }, old.id)).toThrow('баланс уже змінився')
    expect(db.prepare('SELECT count(*) n FROM sync_outbox').get()).toEqual(count)
    expect(pos.getCustomer(old.id)).toMatchObject({ full_name: old.full_name, bonus_balance: 500 })
  })
  it('saves one correction with an audit record, leaving debt and cash untouched', () => {
    const old = create()
    pos.addCustomerDeposit({ customer_id: old.id, amount: 700, method: 'card' })
    const current = pos.getCustomer(old.id)
    const saved = pos.saveCustomer({ full_name: 'Євген', bonus_balance: 1250, expected_bonus_balance: 0, expected_updated_at: current.updated_at, bonus_description: 'Виправлення картки' }, old.id).data
    expect(saved).toMatchObject({ bonus_balance: 1250, debt_balance: 0, deposit_balance: 700, full_name: 'Євген' })
    expect(db.prepare('SELECT amount, description FROM bonus_transactions WHERE customer_id = ?').all(old.id)).toEqual([{ amount: 1250, description: 'Виправлення картки' }])
    expect(() => pos.saveCustomer({ bonus_balance: 1250, expected_bonus_balance: 0 }, old.id)).toThrow()
    expect(db.prepare('SELECT count(*) n FROM bonus_transactions WHERE customer_id = ?').get(old.id)).toEqual({ n: 1 })
  })
  it.each([-1, 1.5, NaN, Infinity])('rejects invalid bonus amount %s', (value) => {
    const customer = create()
    expect(() => pos.saveCustomer({ bonus_balance: value }, customer.id)).toThrow('коректну суму')
    expect(pos.getCustomer(customer.id).bonus_balance).toBe(0)
  })
  it('clears vehicle year and VIN and rejects invalid years', () => {
    const customer = create()
    const car = pos.saveCustomerVehicle(customer.id, { brand: 'VW', model: 'Golf', year: 2012, vin: 'TESTVIN' })
    expect(pos.saveCustomerVehicle(customer.id, { year: null, vin: null }, car.id)).toMatchObject({ year: null, vin: null })
    expect(() => pos.saveCustomerVehicle(customer.id, { year: 1.5 }, car.id)).toThrow('рік')
  })
  it('filters orders by customer before pagination and combines status filters', () => {
    const customer = create()
    const other = pos.saveCustomer({ phone: '0501111111' }).data
    const orders = new LocalOrderRepository(db)
    const wanted = orders.saveOrder({ customer_id: customer.id, items: [] })
    orders.saveOrder({ customer_id: other.id, items: [] })
    orders.saveOrder({ customer_id: other.id, items: [] })
    expect(orders.listOrders({ customer_id: customer.id, limit: 1 }).map((o) => o.id)).toEqual([wanted.id])
    expect(orders.listOrders({ customer_id: customer.id, status: 'completed' })).toEqual([])
  })
  it('uses stable pagination and VIN search', () => {
    const a = create()
    const b = pos.saveCustomer({ phone: '0501111111' }).data
    db.prepare("UPDATE customers SET updated_at = '2026-01-01'").run()
    const rows = [...pos.listCustomers({ page: 1, per_page: 1 }).data, ...pos.listCustomers({ page: 2, per_page: 1 }).data]
    expect(new Set(rows.map((c: any) => c.id))).toEqual(new Set([a.id, b.id]))
    pos.saveCustomerVehicle(a.id, { brand: 'VW', model: 'Golf', vin: 'WVW12345678901234' })
    expect(pos.listCustomers({ search: 'wvw123' }).data.map((c: any) => c.id)).toEqual([a.id])
  })
})

describe('customer write permissions', () => {
  it('cashier cannot write financial terms or spoof an author', () => {
    expect(() => customerWritePayload({ phone: '0501234567', bonus_balance: 500, discount_pct: 90, price_tier_id: 'fake', user_id: 'other' }, { id: 'cashier', role: 'cashier' })).toThrow('Зміни не збережено')
    expect(customerWritePayload({ phone: '0501234567', user_id: 'other' }, { id: 'cashier', role: 'cashier' })).toEqual({ phone: '0501234567', user_id: 'cashier' })
    expect(isDesktopChannelAllowed('desktop:pos:delete-customer', 'cashier')).toBe(false)
  })
  it('cashier saves discounts but cannot change cashback rates or other financial fields', () => {
    expect(customerWritePayload({ discount_pct: 5, user_id: 'fake' }, {id:'cashier',role:'cashier'}, {loyalty_mode:'discount'})).toEqual({ discount_pct:5,user_id:'cashier' })
    expect(customerWritePayload({ discount_pct: 5 }, {id:'cashier',role:'cashier'})).toEqual({ discount_pct:5,user_id:'cashier' })
    expect(() => customerWritePayload({ discount_pct: 5 }, {id:'cashier',role:'cashier'}, {loyalty_mode:'cashback'})).toThrow('накопичень')
    for (const field of ['bonus_balance','price_tier_id','loyalty_mode']) {
      expect(() => customerWritePayload({ [field]: 1 }, {id:'cashier',role:'cashier'})).toThrow('Зміни не збережено')
    }
  })
  it('manager can correct bonuses, owner can delete', () => {
    expect(customerWritePayload({ bonus_balance: 500 }, { id: 'manager', role: 'manager' })).toEqual({ bonus_balance: 500, user_id: 'manager' })
    expect(isDesktopChannelAllowed('desktop:pos:delete-customer', 'owner')).toBe(true)
  })
})
