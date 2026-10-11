import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant, type LocalSaleCheckoutInput } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalStaffRepository } from '../src/repositories/staffRepository'

// Real repositories and a freshly created disposable SQLite database only.
// No application main, fiscal service, device, network or shop database is loaded.
const CASHIER = 'paid-return-cashier'
const WORKER = 'paid-return-worker'
const OTHER_WORKER = 'paid-return-other-worker'
const SALE_DAY = '2026-09-29'
const SALE_TIME = '2026-09-29T10:00:00.000Z'
const PAYOUT_TIME = '2026-10-01T07:30:00.000Z'
const FIRST_RETURN_DAY = '2026-10-02'
const FIRST_RETURN_TIME = '2026-10-02T10:15:00.000Z'
const FINAL_RETURN_DAY = '2026-10-03'
const FINAL_RETURN_TIME = '2026-10-03T11:00:00.000Z'

describe('paid tire-service returns across a month boundary', () => {
  let root: string
  let db: LocalDatabase
  let pos: LocalPosRepository
  let staff: LocalStaffRepository
  let shiftId: string
  let productId: string
  let checkout: LocalSaleCheckoutInput
  let otherSaleId: string
  let otherEvidence: unknown

  function connect(): void {
    db = new LocalDatabase(root)
    pos = new LocalPosRepository(db)
    staff = new LocalStaffRepository(db)
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

  function payout(operationId = 'paid-return-payout') {
    return { operation_id: operationId, tenant_id: tenant, employee_id: WORKER,
      method: 'cash' as const, fund_source: 'cashbox' as const, shift_id: shiftId,
      work_date: SALE_DAY, user_id: CASHIER }
  }

  function returnRequest(saleId: string, operationId: string) {
    const item = pos.getSaleForReturn(saleId).items[0]
    // This is the actual repository entry used by desktop:pos:create-return.
    return { tenant_id: tenant, client_operation_id: operationId, sale_id: saleId,
      cashier_id: CASHIER, approved_by: CASHIER, shift_id: shiftId, is_fiscal: false,
      refund_method: 'cash', reason: 'other', reason_note: 'Synthetic paid tire work return',
      stock_action: 'return_to_stock', items: [{ sale_item_id: item.id,
        product_id: productId, quantity: 1, condition: 'good' }] }
  }

  function workerEvidence(employeeId: string): unknown {
    return {
      salary: db.prepare('SELECT * FROM salary_payments WHERE employee_id = ? ORDER BY id').all(employeeId),
      cash: db.prepare('SELECT * FROM cash_operations WHERE employee_id = ? ORDER BY id').all(employeeId),
      sales: db.prepare('SELECT * FROM sales WHERE manager_id = ? ORDER BY id').all(employeeId),
    }
  }

  function assertOtherWorkerUnchanged(): void {
    expect(workerEvidence(OTHER_WORKER)).toEqual(otherEvidence)
    expect(pos.getSale(otherSaleId).status).toBe('completed')
    expect(staff.salarySummary('2026-09', tenant).find(row => row.employee_id === OTHER_WORKER))
      .toMatchObject({ earned: 2000, paid: 0, balance: 2000 })
    expect(staff.salarySummary('2026-10', tenant).find(row => row.employee_id === OTHER_WORKER)).toBeUndefined()
  }

  function assertReports(originalReceipt: unknown, returned: Array<{ id: string; day: string; time: string }>): void {
    const before = snapshot()
    const original = staff.tireServiceReport(SALE_DAY, tenant)
    expect(original.receipts.filter((row: any) => row.employee_id === WORKER)).toEqual([originalReceipt])
    expect(original.data.find((row: any) => row.employee_id === WORKER)).toMatchObject({
      services_qty: 2, service_revenue: 36000, cash_revenue: 36000, cash_register_received: 36000,
      cash_handed_over: 0, cash_pending: 0, commission_earned: 12600,
      earned: 12600, paid: 12600, balance: 0, due: 0, payable_due: 0,
      salary_available_on: '2026-10-01', salary_ready: true,
    })
    expect(original.salary_operations.filter((row: any) => row.employee_id === WORKER))
      .toEqual([
        expect.objectContaining({ source: 'commission', amount: 12600, work_date: SALE_DAY,
          created_at: SALE_TIME, created_by: CASHIER, cashier_name: 'Никита' }),
        expect.objectContaining({ source: 'daily_payout', amount: 12600, work_date: SALE_DAY,
          created_at: PAYOUT_TIME, created_by: CASHIER, cashier_name: 'Никита' }),
      ])
    expect(original.cash_handovers).toEqual([])
    expect(staff.dailySummary('2026-10-01', tenant)).toEqual([])
    expect(staff.salarySummary('2026-09', tenant).find(row => row.employee_id === WORKER))
      .toMatchObject({ earned: 12600, paid: 12600, balance: 0, total: 0 })
    if (returned.length) {
      expect(staff.salarySummary('2026-10', tenant).find(row => row.employee_id === WORKER))
        .toMatchObject({ earned: -6300 * returned.length, paid: 0, balance: -6300 * returned.length })
    } else {
      expect(staff.salarySummary('2026-10', tenant).find(row => row.employee_id === WORKER)).toBeUndefined()
    }
    for (const item of returned) {
      const report = staff.tireServiceReport(item.day, tenant)
      expect(report.receipts).toEqual([])
      expect(report.data.find((row: any) => row.employee_id === WORKER)).toMatchObject({
        services_qty: 0, service_revenue: 0, cash_register_received: 0, cash_pending: 0,
        commission_earned: -6300, earned: -6300, paid: 0, balance: -6300, due: 0, payable_due: 0,
      })
      expect(report.salary_operations).toEqual([expect.objectContaining({ employee_id: WORKER,
        source: 'commission_reversal', amount: -6300, work_date: item.day, created_at: item.time })])
      expect(db.prepare(`SELECT amount, period, work_date, created_at, cash_operation_id
        FROM salary_payments WHERE commission_source_return_id = ?`).all(item.id))
        .toEqual([{ amount: -6300, period: '2026-10', work_date: item.day,
          created_at: item.time, cash_operation_id: null }])
    }
    assertOtherWorkerUnchanged()
    expect(snapshot()).toEqual(before)
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(SALE_TIME))
    root = mkdtempSync(path.join(tmpdir(), 'forsage-tire-paid-return-month-'))
    connect()
    for (const [id, name, role] of [[CASHIER, 'Никита', 'cashier'],
      [WORKER, 'Андрій', 'tire_worker'], [OTHER_WORKER, 'Контрольний працівник', 'tire_worker']]) {
      db.prepare(`INSERT INTO staff_users
        (id,tenant_id,full_name,role,is_active,base_rate,rate_period,created_at,updated_at)
        VALUES (?,?,?,?,1,0,'day',?,?)`).run(id, tenant, name, role, SALE_TIME, SALE_TIME)
    }
    shiftId = pos.openShift({ cashier_id: CASHIER, opening_cash: 20000 })
    productId = new LocalCatalogRepository(db).upsertProduct({ id: 'paid-return-service',
      sku: 'POS-TIRE-SERVICE', name: 'Шиномонтаж', is_service: true,
      retail_price: 18000, purchase_price: 0, qty_on_hand: 0 }).id
    staff.createCommissionRule({ user_id: WORKER, rule_type: 'tire_service', pct_from_revenue: 35, pct_from_profit: 0 })
    staff.createCommissionRule({ user_id: OTHER_WORKER, rule_type: 'tire_service', pct_from_revenue: 20, pct_from_profit: 0 })
    checkout = { tenant_id: tenant, client_operation_id: 'paid-return-original-sale',
      cashier_id: CASHIER, manager_id: WORKER, shift_id: shiftId, notes: 'Роботи за 29 вересня',
      items: [{ product_id: productId, description: 'Шиномонтажні роботи', qty: 2, unit_price: 18000 }],
      payments: [{ method: 'cash', amount: 36000 }], is_fiscal: false }
    // A genuine independent card sale creates another worker's earnings without changing drawer cash.
    otherSaleId = pos.checkout({ ...checkout, client_operation_id: 'paid-return-control-sale',
      manager_id: OTHER_WORKER, items: [{ product_id: productId, qty: 1, unit_price: 10000 }],
      payments: [{ method: 'card', amount: 10000 }] }).sale_id
    otherEvidence = workerEvidence(OTHER_WORKER)
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(20000)
  })

  afterEach(() => {
    try { db?.close() } finally {
      vi.useRealTimers()
      if (root) {
        const resolved = path.resolve(root)
        if (path.dirname(resolved) === path.resolve(tmpdir())
          && path.basename(resolved).startsWith('forsage-tire-paid-return-month-')
          && realpathSync(resolved) === resolved) rmSync(resolved, { recursive: true, force: true })
      }
    }
  })

  it('keeps September paid gross history and October reversals through partial/final returns and real reopen', () => {
    const sale = pos.checkout(checkout)
    const originalReceipt = staff.tireServiceReport(SALE_DAY).receipts.find((row: any) => row.id === sale.sale_id)
    expect(originalReceipt).toMatchObject({ services_qty: 2, service_revenue: 36000,
      cash_register_received: 36000, commission_earned: 12600, completed_at: SALE_TIME })
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(56000)
    const firstRequest = returnRequest(sale.sale_id, 'paid-return-first')
    const finalRequest = returnRequest(sale.sale_id, 'paid-return-final')
    const beforePayout = snapshot()
    // Kyiv still has 30 September here: exactly two business dates have not elapsed.
    vi.setSystemTime(new Date('2026-09-30T20:59:59.000Z'))
    expect(() => staff.dailyPayout(payout())).toThrow('2026-10-01')
    expect(snapshot()).toEqual(beforePayout)
    restart()
    expect(snapshot()).toEqual(beforePayout)
    vi.setSystemTime(new Date(PAYOUT_TIME))
    const paid = staff.dailyPayout(payout())
    expect(paid).toMatchObject({ amount: 12600, earned: 12600, previously_paid: 0, penalty: 0,
      payment: { employee_id: WORKER, type: 'advance', source: 'daily_payout', amount: 12600,
        period: '2026-09', work_date: SALE_DAY, created_at: PAYOUT_TIME, created_by: CASHIER } })
    const payoutRow = db.prepare('SELECT * FROM salary_payments WHERE id = ?').get(paid.payment.id)
    const payoutCash = db.prepare('SELECT * FROM cash_operations WHERE id = ?').get(paid.payment.cash_operation_id)
    expect(payoutCash).toMatchObject({ type: 'salary_payout', source: 'cashbox', amount: 12600,
      employee_id: WORKER, work_date: SALE_DAY, created_at: PAYOUT_TIME })
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(43400)
    assertReports(originalReceipt, [])

    vi.setSystemTime(new Date(FIRST_RETURN_TIME))
    const first = pos.createReturn(firstRequest)
    expect(first).toMatchObject({ refund_kopecks: 18000, sale_id: sale.sale_id })
    expect(pos.getSale(sale.sale_id).status).toBe('completed')
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(25400)
    const returned = [{ id: first.id, day: FIRST_RETURN_DAY, time: FIRST_RETURN_TIME }]
    assertReports(originalReceipt, returned)
    const partial = snapshot()
    restart()
    expect(snapshot()).toEqual(partial)
    expect(staff.dailyPayout(payout())).toEqual(paid)
    expect(pos.createReturn(firstRequest)).toEqual(first)
    expect(snapshot()).toEqual(partial)

    vi.setSystemTime(new Date(FINAL_RETURN_TIME))
    const final = pos.createReturn(finalRequest)
    expect(final).toMatchObject({ refund_kopecks: 18000, sale_id: sale.sale_id })
    expect(pos.getSale(sale.sale_id).status).toBe('returned')
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(7400)
    returned.push({ id: final.id, day: FINAL_RETURN_DAY, time: FINAL_RETURN_TIME })
    assertReports(originalReceipt, returned)
    expect(db.prepare(`SELECT amount, source, period, work_date, created_at FROM salary_payments
      WHERE employee_id = ? ORDER BY created_at, id`).all(WORKER)).toEqual([
      { amount: 12600, source: 'commission', period: '2026-09', work_date: SALE_DAY, created_at: SALE_TIME },
      { amount: 12600, source: 'daily_payout', period: '2026-09', work_date: SALE_DAY, created_at: PAYOUT_TIME },
      { amount: -6300, source: 'commission_reversal', period: '2026-10', work_date: FIRST_RETURN_DAY, created_at: FIRST_RETURN_TIME },
      { amount: -6300, source: 'commission_reversal', period: '2026-10', work_date: FINAL_RETURN_DAY, created_at: FINAL_RETURN_TIME },
    ])
    expect(db.prepare('SELECT type, amount, created_at FROM cash_operations ORDER BY created_at, id').all())
      .toEqual([
        { type: 'sale_cash', amount: 36000, created_at: SALE_TIME },
        { type: 'salary_payout', amount: 12600, created_at: PAYOUT_TIME },
        { type: 'return_cash', amount: 18000, created_at: FIRST_RETURN_TIME },
        { type: 'return_cash', amount: 18000, created_at: FINAL_RETURN_TIME },
      ])
    expect(db.prepare('SELECT id, created_at FROM customer_returns ORDER BY created_at, id').all())
      .toEqual([{ id: first.id, created_at: FIRST_RETURN_TIME }, { id: final.id, created_at: FINAL_RETURN_TIME }])
    expect(db.prepare('SELECT * FROM inventory_movements WHERE product_id = ?').all(productId)).toEqual([])
    const settled = snapshot()
    for (const reopen of [false, true]) {
      if (reopen) restart()
      expect(snapshot()).toEqual(settled)
      expect(pos.checkout(checkout)).toEqual(sale)
      expect(staff.dailyPayout(payout())).toEqual(paid)
      expect(pos.createReturn(firstRequest)).toEqual(first)
      expect(pos.createReturn(finalRequest)).toEqual(final)
      expect(db.prepare('SELECT * FROM salary_payments WHERE id = ?').get(paid.payment.id)).toEqual(payoutRow)
      expect(db.prepare('SELECT * FROM cash_operations WHERE id = ?').get(paid.payment.cash_operation_id)).toEqual(payoutCash)
      expect(() => staff.dailyPayout(payout('paid-return-new-payout'))).toThrow('немає невиплаченого заробітку')
      expect(() => staff.tireCashHandover({ operation_id: 'paid-return-unwanted-handover',
        employee_id: WORKER, work_date: SALE_DAY, amount: 36000, shift_id: shiftId, user_id: CASHIER }))
        .toThrow('Повторне внесення заборонено')
      assertReports(originalReceipt, returned)
      expect(snapshot()).toEqual(settled)
      expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(7400)
    }
    // No policy about offsetting this negative October balance against another
    // day's future payout is inferred: these checks preserve existing work-date accounting.
  })

  it.each(['cash', 'salary'] as const)('rolls back the mature cross-month payout when its %s write fails, then retries once', (target) => {
    pos.checkout(checkout)
    vi.setSystemTime(new Date(PAYOUT_TIME))
    const before = snapshot()
    const table = target === 'cash' ? 'cash_operations' : 'salary_payments'
    const condition = target === 'cash' ? "NEW.type = 'salary_payout'" : "NEW.source = 'daily_payout'"
    db.exec(`CREATE TRIGGER fixture_paid_return_payout_failure BEFORE INSERT ON ${table}
      WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'synthetic cross-month payout failure'); END`)
    expect(() => staff.dailyPayout(payout())).toThrow('synthetic cross-month payout failure')
    expect(snapshot()).toEqual(before)
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(56000)
    assertOtherWorkerUnchanged()
    db.exec('DROP TRIGGER fixture_paid_return_payout_failure')
    restart()
    expect(snapshot()).toEqual(before)
    const paid = staff.dailyPayout(payout())
    expect(paid).toMatchObject({ amount: 12600, payment: { period: '2026-09',
      work_date: SALE_DAY, created_at: PAYOUT_TIME } })
    expect(pos.getExpectedCash(CASHIER)?.expected_amount).toBe(43400)
    const settled = snapshot()
    restart()
    expect(staff.dailyPayout(payout())).toEqual(paid)
    expect(snapshot()).toEqual(settled)
    assertOtherWorkerUnchanged()
  })
})
