import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant, type LocalSaleCheckoutInput } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalStaffRepository } from '../src/repositories/staffRepository'

// Real repositories and SQLite only, rooted in a new disposable directory.
// No app main, Cashalot, network, device or production database is loaded.
const CASHIER = 'tire-return-cashier'
const WORKER = 'tire-return-worker'
const SALE_DAY = '2026-09-22'
const SALE_TIME = '2026-09-22T13:40:00.000Z'
// Deliberately cross Kyiv midnight while the UTC calendar still shows yesterday.
const FIRST_RETURN_TIME = '2026-09-22T21:30:00.000Z'
const FINAL_RETURN_TIME = '2026-09-23T21:30:00.000Z'
const FIRST_RETURN_DAY = '2026-09-23'
const FINAL_RETURN_DAY = '2026-09-24'

describe('tire-service returns preserve gross work history and settle cash/commission once', () => {
  let root: string
  let db: LocalDatabase
  let pos: LocalPosRepository
  let staff: LocalStaffRepository
  let catalog: LocalCatalogRepository
  let shiftId: string
  let serviceId: string
  let checkout: LocalSaleCheckoutInput

  function connect(): void {
    db = new LocalDatabase(root)
    pos = new LocalPosRepository(db)
    staff = new LocalStaffRepository(db)
    catalog = new LocalCatalogRepository(db)
  }

  function restart(): void {
    const previous = db
    const identity = db.deviceId
    const databasePath = db.databasePath
    db.close()
    connect()
    expect(db === previous).toBe(false)
    expect(db.deviceId).toBe(identity)
    expect(db.databasePath).toBe(databasePath)
  }

  function snapshot(): Record<string, unknown[]> {
    return db.readSnapshot(() => {
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>
      return Object.fromEntries(tables.map(({ name }) => [name,
        db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all()
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ]))
    })
  }

  function returnRequest(saleId: string, operationId: string, items: Array<{ id: string; product_id: string; quantity: number }>) {
    // This is the repository entry used by desktop:pos:create-return in main.
    return { tenant_id: tenant, client_operation_id: operationId, sale_id: saleId,
      approved_by: CASHIER, cashier_id: CASHIER, shift_id: shiftId, is_fiscal: false,
      reason: 'other', reason_note: 'Synthetic tire work refund', refund_method: 'cash',
      stock_action: 'return_to_stock', items: items.map(item => ({ sale_item_id: item.id,
        product_id: item.product_id, quantity: item.quantity, condition: 'good' })) }
  }

  function assertOriginalReport(originalReceipt: unknown, commission: number, cashRevenue: number): void {
    const before = snapshot()
    const report = staff.tireServiceReport(SALE_DAY, tenant)
    // Soft report assertions let RED continue through the money/replay checks.
    expect.soft(report.receipts).toEqual([originalReceipt])
    expect.soft(report.data).toEqual([expect.objectContaining({ employee_id: WORKER,
      services_qty: 2, service_revenue: 36000, commission_earned: commission,
      earned: commission, cash_revenue: cashRevenue, cash_register_received: cashRevenue, cash_pending: 0 })])
    expect.soft(report.totals).toMatchObject({ services_qty: 2, service_revenue: 36000,
      cash_revenue: cashRevenue, cash_register_received: cashRevenue, cash_pending: 0 })
    expect(report.salary_operations).toEqual([expect.objectContaining({ source: 'commission',
      amount: commission, work_date: SALE_DAY, created_by: CASHIER, cashier_name: 'Никита' })])
    expect(snapshot()).toEqual(before)
  }

  function assertReversalDay(day: string, returnId: string, amount: number): void {
    const before = snapshot()
    const report = staff.tireServiceReport(day, tenant)
    expect(report.receipts).toEqual([])
    expect(report.salary_operations).toEqual([expect.objectContaining({ source: 'commission_reversal',
      amount, work_date: day, created_by: CASHIER, cashier_name: 'Никита' })])
    expect(report.data).toEqual([expect.objectContaining({ employee_id: WORKER,
      commission_earned: amount, earned: amount, balance: amount, due: 0, cash_pending: 0 })])
    expect(db.prepare(`SELECT amount, work_date FROM salary_payments
      WHERE commission_source_return_id = ? AND source = 'commission_reversal'`).all(returnId))
      .toEqual([{ amount, work_date: day }])
    expect(snapshot()).toEqual(before)
  }

  function assertNoHandover(): void {
    const before = snapshot()
    expect(() => staff.tireCashHandover({ operation_id: 'tire-return-unwanted-handover',
      employee_id: WORKER, work_date: SALE_DAY, shift_id: shiftId, amount: 36000, user_id: CASHIER }))
      .toThrow('Повторне внесення заборонено')
    expect(snapshot()).toEqual(before)
    expect(db.prepare("SELECT * FROM cash_operations WHERE type = 'cash_in' AND employee_id = ?").all(WORKER)).toEqual([])
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(SALE_TIME))
    root = mkdtempSync(path.join(tmpdir(), 'forsage-tire-return-settlement-'))
    connect()
    for (const [id, name, role] of [[CASHIER, 'Никита', 'cashier'], [WORKER, 'Андрій', 'tire_worker']]) {
      db.prepare(`INSERT INTO staff_users
        (id,tenant_id,full_name,role,is_active,base_rate,rate_period,created_at,updated_at)
        VALUES (?,?,?,?,1,0,'day',?,?)`).run(id, tenant, name, role, SALE_TIME, SALE_TIME)
    }
    shiftId = pos.openShift({ cashier_id: CASHIER, opening_cash: 1000 })
    serviceId = catalog.upsertProduct({ id: 'tire-return-service', sku: 'POS-TIRE-SERVICE',
      name: 'Шиномонтаж', is_service: true, retail_price: 18000, purchase_price: 0, qty_on_hand: 0 }).id
    staff.createCommissionRule({ user_id: WORKER, rule_type: 'tire_service', pct_from_revenue: 35, pct_from_profit: 0 })
    checkout = { tenant_id: tenant, client_operation_id: 'tire-return-original-sale',
      cashier_id: CASHIER, manager_id: WORKER, shift_id: shiftId, notes: 'Шиномонтаж: два комплекти робіт',
      items: [{ product_id: serviceId, description: 'Шиномонтажні роботи', qty: 2, unit_price: 18000 }],
      payments: [{ method: 'cash', amount: 36000 }], is_fiscal: false }
  })

  afterEach(() => {
    try { db?.close() } finally {
      vi.useRealTimers()
      const resolved = path.resolve(root)
      if (path.dirname(resolved) === path.resolve(tmpdir())
        && path.basename(resolved).startsWith('forsage-tire-return-settlement-')
        && realpathSync(resolved) === resolved) rmSync(resolved, { recursive: true, force: true })
    }
  })

  it('keeps the original 36000 work day after 18000 + 18000 refunds and separate -6300 salary reversals', () => {
    const sale = pos.checkout(checkout)
    const original = staff.tireServiceReport(SALE_DAY).receipts[0]
    expect(original).toMatchObject({ id: sale.sale_id, service_revenue: 36000, services_qty: 2,
      cash_register_received: 36000, commission_earned: 12600, notes: checkout.notes })
    const item = pos.getSaleForReturn(sale.sale_id).items[0]
    const firstRequest = returnRequest(sale.sale_id, 'tire-return-first', [{ ...item, quantity: 1 }])
    const finalRequest = returnRequest(sale.sale_id, 'tire-return-final', [{ ...item, quantity: 1 }])
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(37000)
    restart()
    vi.setSystemTime(new Date(FIRST_RETURN_TIME))
    const first = pos.createReturn(firstRequest)
    expect(first).toMatchObject({ refund_kopecks: 18000, sale_id: sale.sale_id })
    expect(pos.getSale(sale.sale_id).status).toBe('completed')
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(19000)
    assertOriginalReport(original, 12600, 36000)
    assertReversalDay(FIRST_RETURN_DAY, first.id, -6300)
    const partial = snapshot()
    restart()
    expect(pos.createReturn(firstRequest)).toEqual(first)
    expect(snapshot()).toEqual(partial)

    vi.setSystemTime(new Date(FINAL_RETURN_TIME))
    const final = pos.createReturn(finalRequest)
    expect(final).toMatchObject({ refund_kopecks: 18000, sale_id: sale.sale_id })
    expect(pos.getSale(sale.sale_id).status).toBe('returned')
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(1000)
    assertOriginalReport(original, 12600, 36000)
    assertReversalDay(FIRST_RETURN_DAY, first.id, -6300)
    assertReversalDay(FINAL_RETURN_DAY, final.id, -6300)
    expect(db.prepare(`SELECT amount, source, work_date FROM salary_payments WHERE employee_id = ?
      ORDER BY created_at, id`).all(WORKER)).toEqual([
      { amount: 12600, source: 'commission', work_date: SALE_DAY },
      { amount: -6300, source: 'commission_reversal', work_date: FIRST_RETURN_DAY },
      { amount: -6300, source: 'commission_reversal', work_date: FINAL_RETURN_DAY },
    ])
    expect(db.prepare('SELECT type, amount FROM cash_operations ORDER BY created_at, id').all())
      .toEqual([{ type: 'sale_cash', amount: 36000 }, { type: 'return_cash', amount: 18000 }, { type: 'return_cash', amount: 18000 }])
    expect(db.prepare('SELECT * FROM inventory_movements WHERE product_id = ?').all(serviceId)).toEqual([])
    expect(catalog.findById(serviceId)?.qty_on_hand).toBe(0)
    assertNoHandover()
    const completed = snapshot()
    for (const reopen of [false, true]) {
      if (reopen) restart()
      expect(pos.checkout(checkout)).toEqual(sale)
      expect(pos.createReturn(firstRequest)).toEqual(first)
      expect(pos.createReturn(finalRequest)).toEqual(final)
      assertOriginalReport(original, 12600, 36000)
      assertReversalDay(FINAL_RETURN_DAY, final.id, -6300)
      expect(snapshot()).toEqual(completed)
      expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(1000)
    }
  })

  it('preserves the original discounted mixed receipt while real returns restore goods and reverse only its saved tire commission', () => {
    const goods = catalog.upsertProduct({ id: 'tire-return-goods', sku: 'TIRE-RETURN-GOODS',
      name: 'Контрольний товар', qty_on_hand: 5, retail_price: 24000, purchase_price: 15000 }).id
    const request: LocalSaleCheckoutInput = { ...checkout, discount: 6000,
      items: [...checkout.items, { product_id: goods, qty: 1, unit_price: 24000 }],
      payments: [{ method: 'cash', amount: 54000 }] }
    const sale = pos.checkout(request)
    const original = staff.tireServiceReport(SALE_DAY).receipts[0]
    expect(original).toMatchObject({ total: 54000, service_revenue: 36000,
      cash_register_received: 32400, commission_earned: 11340 })
    const items = pos.getSaleForReturn(sale.sale_id).items as Array<{ id: string; product_id: string }>
    const service = items.find(item => item.product_id === serviceId)!
    const product = items.find(item => item.product_id === goods)!
    const firstRequest = returnRequest(sale.sale_id, 'mixed-tire-return-first', [{ ...service, quantity: 1 }])
    const finalRequest = returnRequest(sale.sale_id, 'mixed-tire-return-final',
      [{ ...service, quantity: 1 }, { ...product, quantity: 1 }])
    vi.setSystemTime(new Date(FIRST_RETURN_TIME))
    const first = pos.createReturn(firstRequest)
    expect(first.refund_kopecks).toBe(16200)
    expect(catalog.findById(goods)?.qty_on_hand).toBe(4)
    assertOriginalReport(original, 11340, 32400)
    assertReversalDay(FIRST_RETURN_DAY, first.id, -5670)
    restart()
    vi.setSystemTime(new Date(FINAL_RETURN_TIME))
    const final = pos.createReturn(finalRequest)
    expect(final.refund_kopecks).toBe(37800)
    expect(pos.getSale(sale.sale_id).status).toBe('returned')
    expect(catalog.findById(goods)?.qty_on_hand).toBe(5)
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(1000)
    assertOriginalReport(original, 11340, 32400)
    assertReversalDay(FINAL_RETURN_DAY, final.id, -5670)
    assertNoHandover()
    const settled = snapshot()
    restart()
    expect(pos.createReturn(firstRequest)).toEqual(first)
    expect(pos.createReturn(finalRequest)).toEqual(final)
    expect(pos.checkout(request)).toEqual(sale)
    assertOriginalReport(original, 11340, 32400)
    expect(snapshot()).toEqual(settled)
  })

  it('rolls back final return, cash, stock, status, audit and outbox if salary reversal cannot persist, then retries once', () => {
    const sale = pos.checkout(checkout)
    const original = staff.tireServiceReport(SALE_DAY).receipts[0]
    const item = pos.getSaleForReturn(sale.sale_id).items[0]
    const request = returnRequest(sale.sale_id, 'tire-return-rollback', [{ ...item, quantity: 2 }])
    const before = snapshot()
    db.exec(`CREATE TRIGGER fixture_tire_reversal_failure BEFORE INSERT ON salary_payments
      WHEN NEW.source = 'commission_reversal'
      BEGIN SELECT RAISE(ABORT, 'synthetic tire reversal persistence failure'); END`)
    vi.setSystemTime(new Date(FIRST_RETURN_TIME))
    expect(() => pos.createReturn(request)).toThrow('synthetic tire reversal persistence failure')
    expect(snapshot()).toEqual(before)
    expect(pos.getSale(sale.sale_id).status).toBe('completed')
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(37000)
    assertOriginalReport(original, 12600, 36000)
    db.exec('DROP TRIGGER fixture_tire_reversal_failure')
    restart()
    expect(snapshot()).toEqual(before)
    const returned = pos.createReturn(request)
    expect(returned.refund_kopecks).toBe(36000)
    expect(pos.getSale(sale.sale_id).status).toBe('returned')
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(1000)
    assertOriginalReport(original, 12600, 36000)
    assertReversalDay(FIRST_RETURN_DAY, returned.id, -12600)
    const settled = snapshot()
    restart()
    expect(pos.createReturn(request)).toEqual(returned)
    expect(snapshot()).toEqual(settled)
    assertNoHandover()
  })
})
