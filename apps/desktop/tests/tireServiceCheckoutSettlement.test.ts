import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant, type LocalSaleCheckoutInput } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalStaffRepository } from '../src/repositories/staffRepository'

// Only repository code and an explicitly supplied disposable SQLite root are
// loaded: no application main, Cashalot, device, registry or network adapters.
const CASHIER = 'tire-settlement-cashier'
const WORKER = 'tire-settlement-worker'
const WORK_DATE = '2026-09-22'
const SALE_TIME = '2026-09-22T13:40:00.000Z'
const SETTLEMENT_TIME = '2026-09-25T07:30:00.000Z'
const OPENING_CASH = 1000
const REVENUE = 36000
const COMMISSION = 12600
const COMMENT = 'Шиномонтаж: заміна 4 коліс R16'

describe('real tire-service checkout, cash handover and salary settlement', () => {
  let root: string
  let db: LocalDatabase
  let pos: LocalPosRepository
  let staff: LocalStaffRepository
  let productId: string
  let shiftId: string
  let checkout: LocalSaleCheckoutInput

  function connect(): void {
    db = new LocalDatabase(root)
    pos = new LocalPosRepository(db)
    staff = new LocalStaffRepository(db)
  }

  function restart(): void {
    const previous = db
    const databasePath = db.databasePath
    const deviceId = db.deviceId
    db.close()
    connect()
    expect(db === previous).toBe(false)
    expect(db.databasePath).toBe(databasePath)
    expect(db.deviceId).toBe(deviceId)
  }

  function snapshot(): Record<string, unknown[]> {
    return db.readSnapshot(() => {
      const tables = db.prepare(`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>
      return Object.fromEntries(tables.map(({ name }) => [name,
        db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all()
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ]))
    })
  }

  function handover(amount = REVENUE, operationId = 'tire-cash-handover') {
    return { operation_id: operationId, tenant_id: tenant, employee_id: WORKER,
      employee_name: 'Андрій', work_date: WORK_DATE, shift_id: shiftId, amount, user_id: CASHIER }
  }

  function payout() {
    return { operation_id: 'tire-salary-payout', tenant_id: tenant, employee_id: WORKER,
      method: 'cash' as const, fund_source: 'cashbox' as const, shift_id: shiftId,
      work_date: WORK_DATE, user_id: CASHIER }
  }

  function reportReceipt(saleId: string, cashRevenue = REVENUE): void {
    const before = snapshot()
    const report = staff.tireServiceReport(WORK_DATE, tenant)
    expect(report.details_version).toBe(1)
    expect(report.receipts).toHaveLength(1)
    expect(report.receipts[0]).toMatchObject({ id: saleId, cashier_id: CASHIER,
      cashier_name: 'Никита', employee_id: WORKER, employee_name: 'Андрій', notes: COMMENT,
      completed_at: SALE_TIME, services_qty: 2, service_revenue: REVENUE,
      cash_revenue: cashRevenue, cash_register_received: cashRevenue, commission_earned: COMMISSION })
    expect(report.receipts[0].services).toEqual(expect.arrayContaining([
      expect.objectContaining({ description: 'Заміна коліс', qty: 1, unit_price: 24000, total: 24000 }),
      expect.objectContaining({ description: 'Балансування', qty: 1, unit_price: 12000, total: 12000 }),
    ]))
    expect(report.receipts[0].services).toHaveLength(2)
    expect(report.salary_operations.filter((row: { source: string }) => row.source === 'commission'))
      .toEqual([expect.objectContaining({ employee_id: WORKER, sale_id: saleId, amount: COMMISSION,
        source: 'commission', created_by: CASHIER, cashier_name: 'Никита', work_date: WORK_DATE })])
    expect(snapshot()).toEqual(before)
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(SALE_TIME))
    root = mkdtempSync(path.join(tmpdir(), 'forsage-tire-checkout-settlement-'))
    connect()
    for (const [id, name, role] of [[CASHIER, 'Никита', 'cashier'], [WORKER, 'Андрій', 'tire_worker']]) {
      db.prepare(`INSERT INTO staff_users
        (id, tenant_id, full_name, role, is_active, base_rate, rate_period, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 0, 'day', ?, ?)`).run(id, tenant, name, role, SALE_TIME, SALE_TIME)
    }
    shiftId = pos.openShift({ cashier_id: CASHIER, opening_cash: OPENING_CASH })
    productId = new LocalCatalogRepository(db).upsertProduct({ id: 'tire-settlement-service',
      sku: 'POS-TIRE-SERVICE', name: 'Шиномонтаж', is_service: true,
      retail_price: REVENUE, purchase_price: 0, qty_on_hand: 0 }).id
    staff.createCommissionRule({ user_id: WORKER, rule_type: 'tire_service',
      pct_from_revenue: 35, pct_from_profit: 0 })
    checkout = { client_operation_id: 'tire-service-checkout', tenant_id: tenant,
      cashier_id: CASHIER, manager_id: WORKER, shift_id: shiftId, notes: COMMENT,
      items: [
        { product_id: productId, description: 'Заміна коліс', qty: 1, unit_price: 24000 },
        { product_id: productId, description: 'Балансування', qty: 1, unit_price: 12000 },
      ], payments: [{ method: 'cash', amount: REVENUE }], is_fiscal: false }
  })

  afterEach(() => {
    try { db?.close() } finally {
      vi.useRealTimers()
      const resolved = path.resolve(root)
      if (path.dirname(resolved) === path.resolve(tmpdir())
        && path.basename(resolved).startsWith('forsage-tire-checkout-settlement-')
        && realpathSync(resolved) === resolved) {
        rmSync(resolved, { recursive: true, force: true })
      }
    }
  })

  it('creates its sale, detailed report and 35% commission through checkout and replays unchanged after reopen', () => {
    const first = pos.checkout(checkout)
    expect(first).toMatchObject({ total: REVENUE, payment_method: 'cash' })
    reportReceipt(first.sale_id)
    expect(staff.tireServiceReport(WORK_DATE).data).toEqual([expect.objectContaining({
      employee_id: WORKER, commission_earned: COMMISSION, earned: COMMISSION,
      paid: 0, due: COMMISSION, cash_pending: 0, cash_register_received: REVENUE, salary_ready: false,
    })])
    expect(db.prepare('SELECT * FROM inventory_movements WHERE source_id = ?').all(first.sale_id)).toEqual([])
    expect(db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get(productId)).toEqual({ qty_on_hand: 0 })
    expect(db.prepare('SELECT method, amount FROM sale_payments WHERE sale_id = ?').all(first.sale_id))
      .toEqual([{ method: 'cash', amount: REVENUE }])
    expect(db.prepare(`SELECT amount, source, type, commission_source_sale_id
      FROM salary_payments WHERE employee_id = ?`).all(WORKER))
      .toEqual([{ amount: COMMISSION, source: 'commission', type: 'bonus', commission_source_sale_id: first.sale_id }])
    expect(db.prepare(`SELECT COUNT(*) count FROM sync_outbox
      WHERE aggregate_id = ? AND operation_type = 'sale.completed'`).get(first.sale_id)).toEqual({ count: 1 })
    const committed = snapshot()
    for (const reopen of [false, true]) {
      if (reopen) restart()
      expect(pos.checkout(checkout)).toEqual(first)
      reportReceipt(first.sale_id)
      expect(snapshot()).toEqual(committed)
    }
  })

  it('counts POS cash once, rejects duplicate handovers atomically and permits a mature payout without handover', () => {
    const sale = pos.checkout(checkout)
    const beforeSettlement = snapshot()
    restart()
    expect(snapshot()).toEqual(beforeSettlement)
    reportReceipt(sale.sale_id)
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(OPENING_CASH + REVENUE)
    expect(() => staff.dailyPayout(payout())).toThrow('2026-09-24')
    expect(snapshot()).toEqual(beforeSettlement)
    for (const reopen of [false, true]) {
      if (reopen) restart()
      expect(() => staff.tireCashHandover(handover(10000, 'tire-partial-handover'))).toThrow('Повторне внесення заборонено')
      expect(() => staff.tireCashHandover(handover())).toThrow('Повторне внесення заборонено')
      expect(snapshot()).toEqual(beforeSettlement)
    }
    vi.setSystemTime(new Date(SETTLEMENT_TIME))
    const report = staff.tireServiceReport(WORK_DATE)
    expect(report.data).toEqual([expect.objectContaining({ cash_handed_over: 0, cash_register_received: REVENUE, cash_pending: 0,
      commission_earned: COMMISSION, due: COMMISSION, salary_ready: true, payable_due: COMMISSION })])
    expect(report.totals).toMatchObject({ cash_register_received: REVENUE, cash_handed_over: 0, cash_pending: 0 })
    expect(report.cash_handovers).toEqual([])

    const paid = staff.dailyPayout(payout())
    expect(paid).toMatchObject({ amount: COMMISSION, earned: COMMISSION, previously_paid: 0, penalty: 0,
      payment: { employee_id: WORKER, source: 'daily_payout', type: 'advance', amount: COMMISSION,
        work_date: WORK_DATE, created_at: SETTLEMENT_TIME, created_by: CASHIER } })
    expect(staff.tireServiceReport(WORK_DATE).data).toEqual([expect.objectContaining({
      earned: COMMISSION, paid: COMMISSION, due: 0, cash_pending: 0,
    })])
    expect(staff.dailySummary('2026-09-25')).toEqual([])
    expect(db.prepare(`SELECT type, source, amount, employee_id, work_date FROM cash_operations
      WHERE type = 'salary_payout'`).all()).toEqual([{ type: 'salary_payout', source: 'cashbox',
      amount: COMMISSION, employee_id: WORKER, work_date: WORK_DATE }])
    reportReceipt(sale.sale_id)
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(OPENING_CASH + REVENUE - COMMISSION)
    const settled = snapshot()
    for (const reopen of [false, true]) {
      if (reopen) restart()
      expect(pos.checkout(checkout)).toEqual(sale)
      expect(() => staff.tireCashHandover(handover())).toThrow('Повторне внесення заборонено')
      expect(staff.dailyPayout(payout())).toEqual(paid)
      expect(snapshot()).toEqual(settled)
      expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(OPENING_CASH + REVENUE - COMMISSION)
    }
  })

  it('keeps checkout and its generated cash, commission, stock and outbox atomic when salary persistence fails', () => {
    const before = snapshot()
    db.exec(`CREATE TRIGGER fixture_tire_commission_failure BEFORE INSERT ON salary_payments
      WHEN NEW.source = 'commission'
      BEGIN SELECT RAISE(ABORT, 'synthetic tire commission persistence failure'); END`)
    expect(() => pos.checkout(checkout)).toThrow('synthetic tire commission persistence failure')
    expect(snapshot()).toEqual(before)
    db.exec('DROP TRIGGER fixture_tire_commission_failure')
    restart()
    expect(snapshot()).toEqual(before)
    const sale = pos.checkout(checkout)
    reportReceipt(sale.sale_id)
    const committed = snapshot()
    restart()
    expect(pos.checkout(checkout)).toEqual(sale)
    expect(snapshot()).toEqual(committed)
  })

  it('records the same commission for a card-paid service without inventing cash or a handover obligation', () => {
    const cardCheckout: LocalSaleCheckoutInput = { ...checkout, payments: [{ method: 'card', amount: REVENUE }] }
    const sale = pos.checkout(cardCheckout)
    expect(sale).toMatchObject({ total: REVENUE, payment_method: 'card' })
    reportReceipt(sale.sale_id, 0)
    expect(db.prepare('SELECT * FROM cash_operations WHERE sale_id = ?').all(sale.sale_id)).toEqual([])
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(OPENING_CASH)
    expect(staff.tireServiceReport(WORK_DATE).data).toEqual([expect.objectContaining({
      earned: COMMISSION, cash_revenue: 0, cash_pending: 0, cash_handed_over: 0,
      salary_ready: false, payable_due: 0,
    })])
    const committed = snapshot()
    restart()
    expect(pos.checkout(cardCheckout)).toEqual(sale)
    expect(snapshot()).toEqual(committed)
    vi.setSystemTime(new Date(SETTLEMENT_TIME))
    expect(staff.tireServiceReport(WORK_DATE).data[0]).toMatchObject({
      due: COMMISSION, salary_ready: true, payable_due: COMMISSION,
    })
    expect(() => staff.tireCashHandover(handover())).toThrow('Повторне внесення заборонено')
    expect(() => staff.dailyPayout(payout())).toThrow('недостатньо готівки')
    expect(snapshot()).toEqual(committed)
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(OPENING_CASH)
  })

  it('reports only the discounted 30000 customer cash for a 36000 tire service with a 6000 receipt discount', () => {
    const discountedCheckout: LocalSaleCheckoutInput = { ...checkout, discount: 6000,
      payments: [{ method: 'cash', amount: 30000 }] }
    const sale = pos.checkout(discountedCheckout)
    expect(sale).toMatchObject({ subtotal: REVENUE, total: 30000, payment_method: 'cash' })
    const committed = snapshot()
    for (const reopen of [false, true]) {
      if (reopen) restart()
      const report = staff.tireServiceReport(WORK_DATE, tenant)
      expect(report.receipts).toHaveLength(1)
      expect(report.receipts[0]).toMatchObject({ id: sale.sale_id, total: 30000, commission_earned: 10500 })
      expect(report.data).toEqual([expect.objectContaining({ employee_id: WORKER,
        commission_earned: 10500, earned: 10500, paid: 0, due: 10500 })])
      expect(report.receipts[0]).toMatchObject({ cash_revenue: 30000, cash_register_received: 30000 })
      expect(report.data[0]).toMatchObject({ cash_revenue: 30000, cash_register_received: 30000, cash_pending: 0 })
      expect(report.totals).toMatchObject({ cash_revenue: 30000, cash_register_received: 30000, cash_pending: 0 })
      expect(snapshot()).toEqual(committed)
      expect(pos.checkout(discountedCheckout)).toEqual(sale)
      expect(snapshot()).toEqual(committed)
    }
  })

  it('allocates the mixed receipt discount before assigning its cash share to tire service', () => {
    const goodsId = new LocalCatalogRepository(db).upsertProduct({ id: 'tire-settlement-goods',
      sku: 'TIRE-SETTLEMENT-GOODS', name: 'Контрольний товар', is_service: false,
      retail_price: 24000, purchase_price: 15000, qty_on_hand: 5 }).id
    const mixedCheckout: LocalSaleCheckoutInput = { ...checkout, discount: 6000,
      items: [...checkout.items, { product_id: goodsId, description: 'Контрольний товар', qty: 1, unit_price: 24000 }],
      payments: [{ method: 'cash', amount: 27000 }, { method: 'card', amount: 27000 }] }
    const sale = pos.checkout(mixedCheckout)
    expect(sale).toMatchObject({ subtotal: 60000, total: 54000, payment_method: 'mixed' })
    expect(db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get(goodsId)).toEqual({ qty_on_hand: 4 })
    const committed = snapshot()
    for (const reopen of [false, true]) {
      if (reopen) restart()
      const report = staff.tireServiceReport(WORK_DATE, tenant)
      expect(report.receipts).toHaveLength(1)
      // Tire net revenue is 54000 * 36000 / 60000 = 32400;
      // its saved 35% commission is 11340 and the 50% cash share is 16200.
      // Deliberately do not prescribe whether displayed service_revenue is gross.
      expect(report.receipts[0]).toMatchObject({ id: sale.sale_id, total: 54000, commission_earned: 11340 })
      expect(report.receipts[0].services).toHaveLength(2)
      expect(report.data).toEqual([expect.objectContaining({ employee_id: WORKER,
        commission_earned: 11340, earned: 11340, paid: 0, due: 11340 })])
      expect(report.receipts[0]).toMatchObject({ cash_revenue: 16200, cash_register_received: 16200 })
      expect(report.data[0]).toMatchObject({ cash_revenue: 16200, cash_register_received: 16200, cash_pending: 0 })
      expect(report.totals).toMatchObject({ cash_revenue: 16200, cash_register_received: 16200, cash_pending: 0 })
      expect(snapshot()).toEqual(committed)
      expect(pos.checkout(mixedCheckout)).toEqual(sale)
      expect(snapshot()).toEqual(committed)
    }
  })

  it('registers overnight worker cash in the next cashier shift while crediting the actual off-duty worker', () => {
    const oldShift = shiftId
    pos.closeShift(CASHIER, OPENING_CASH, 'Закриття перед пізньою роботою', oldShift)
    vi.setSystemTime(new Date('2026-09-23T07:00:00.000Z'))
    const nextCashier = 'tire-settlement-next-cashier'
    db.prepare(`INSERT INTO staff_users
      (id, tenant_id, full_name, role, is_active, base_rate, rate_period, created_at, updated_at)
      VALUES (?, ?, 'Олена', 'cashier', 1, 0, 'day', ?, ?)`).run(nextCashier, tenant, SALE_TIME, SALE_TIME)
    const nextShift = pos.openShift({ cashier_id: nextCashier, opening_cash: 0 })
    // There is deliberately no worker duty/check-in record on the new day.
    const request: LocalSaleCheckoutInput = { ...checkout, cashier_id: nextCashier,
      shift_id: nextShift, manager_id: WORKER, notes: 'Внесено вранці за вечірню роботу Андрія' }
    const sale = pos.checkout(request)
    expect(db.prepare('SELECT cashier_id, manager_id, shift_id FROM sales WHERE id = ?').get(sale.sale_id))
      .toEqual({ cashier_id: nextCashier, manager_id: WORKER, shift_id: nextShift })
    expect(db.prepare('SELECT amount, source, type, shift_id, user_id FROM cash_operations WHERE sale_id = ?').all(sale.sale_id))
      .toEqual([{ amount: REVENUE, source: 'cashbox', type: 'sale_cash', shift_id: nextShift, user_id: nextCashier }])
    const report = staff.tireServiceReport('2026-09-23')
    expect(report.receipts).toEqual([expect.objectContaining({ id: sale.sale_id, employee_id: WORKER,
      cashier_id: nextCashier, cashier_name: 'Олена', commission_earned: COMMISSION,
      cash_register_received: REVENUE, notes: request.notes })])
    expect(report.data).toEqual([expect.objectContaining({ employee_id: WORKER, earned: COMMISSION,
      cash_pending: 0, cash_register_received: REVENUE })])
    expect(pos.getExpectedCash(nextCashier)?.expected_amount).toBe(REVENUE)
    expect(pos.getExpectedCash(CASHIER)).toBeNull()
    const committed = snapshot()
    restart()
    expect(pos.checkout(request)).toEqual(sale)
    expect(staff.tireServiceReport('2026-09-23')).toEqual(report)
    expect(snapshot()).toEqual(committed)
  })

  it('shows historical manual handovers separately without silently repairing an old double-counted drawer', () => {
    const sale = pos.checkout(checkout)
    // Only seed the historical extra movement: new production calls cannot
    // create it. A read must neither hide this evidence nor rewrite the ledger.
    db.prepare(`INSERT INTO cash_operations
      (id,tenant_id,shift_id,user_id,type,source,amount,employee_id,work_date,notes,created_at,updated_at)
      VALUES ('legacy-tire-handover',?,?,?,'cash_in','cashbox',?,?,?,'Historical duplicate',?,?)`)
      .run(tenant, shiftId, CASHIER, REVENUE, WORKER, WORK_DATE, SALE_TIME, SALE_TIME)
    const historical = snapshot()
    for (const reopen of [false, true]) {
      if (reopen) restart()
      const report = staff.tireServiceReport(WORK_DATE)
      expect(report.receipts[0]).toMatchObject({ id: sale.sale_id, cash_register_received: REVENUE })
      expect(report.data[0]).toMatchObject({ cash_register_received: REVENUE,
        cash_handed_over: REVENUE, cash_pending: 0 })
      expect(report.cash_handovers).toEqual([expect.objectContaining({ id: 'legacy-tire-handover',
        amount: REVENUE, employee_id: WORKER, work_date: WORK_DATE, note: 'Historical duplicate' })])
      expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(OPENING_CASH + 2 * REVENUE)
      expect(() => staff.tireCashHandover(handover())).toThrow('Повторне внесення заборонено')
      expect(snapshot()).toEqual(historical)
    }
  })
})
