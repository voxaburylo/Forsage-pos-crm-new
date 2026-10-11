import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant, type LocalSaleCheckoutInput } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalStaffRepository } from '../src/repositories/staffRepository'

// Real repositories, actual shift close/open and a private temporary SQLite file.
// No main process, fiscal service, network, devices or shop database is loaded.
const CASHIER_A = 'closed-tire-cashier-a'
const CASHIER_B = 'closed-tire-cashier-b'
const WORKER = 'closed-tire-actual-worker'
const WORK_DAY = '2026-09-29'
const SALE_TIME = '2026-09-29T10:00:00.000Z'
const PAYOUT_TIME = '2026-10-01T08:00:00.000Z'
const FIRST_RETURN_TIME = '2026-10-02T10:00:00.000Z'
const FINAL_RETURN_TIME = '2026-10-03T10:00:00.000Z'

describe('tire settlement across closed cashier shifts and a month boundary', () => {
  let root: string
  let db: LocalDatabase
  let pos: LocalPosRepository
  let staff: LocalStaffRepository
  let productId: string
  let closed: Array<{ id: string; cashier: string; amount: number; comment: string;
    result: { ok: true; id: string }; evidence: unknown }>

  function connect(): void {
    db = new LocalDatabase(root)
    pos = new LocalPosRepository(db)
    staff = new LocalStaffRepository(db)
  }

  function restart(): void {
    const previous = db, databasePath = db.databasePath, deviceId = db.deviceId
    db.close()
    connect()
    expect(db === previous).toBe(false)
    expect(db.databasePath).toBe(databasePath)
    expect(db.deviceId).toBe(deviceId)
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

  function shiftEvidence(id: string): unknown {
    // getShiftReport intentionally exposes only the current open shift. Closed
    // evidence is its persisted close, cash/salary rows, events and backup marker;
    // never mutate status or mock getOpenShift to manufacture a historical report.
    return {
      shift: db.prepare('SELECT * FROM shifts WHERE id = ?').get(id),
      cash: db.prepare('SELECT * FROM cash_operations WHERE shift_id = ? ORDER BY id').all(id),
      salary: db.prepare('SELECT * FROM salary_payments WHERE shift_id = ? ORDER BY id').all(id),
      returns: db.prepare('SELECT * FROM customer_returns WHERE shift_id = ? ORDER BY id').all(id),
      events: db.prepare("SELECT * FROM sync_outbox WHERE aggregate_type = 'shift' AND aggregate_id = ? ORDER BY sequence").all(id),
      backup: db.prepare('SELECT * FROM shift_backups WHERE id = ?').get(id),
    }
  }

  function assertClosedUnchanged(): void {
    const before = snapshot()
    for (const item of closed) {
      expect(shiftEvidence(item.id)).toEqual(item.evidence)
      expect(pos.closeShift(item.cashier, item.amount, item.comment, item.id)).toEqual(item.result)
    }
    expect(snapshot()).toEqual(before)
  }

  function open(cashier: string, time: string, openingCash: number): string {
    vi.setSystemTime(new Date(time))
    // The real API uses this explicit counted amount; POS pre-fills the last
    // closing amount in its form, but no repository auto-carry/cash_in exists.
    const request = { cashier_id: cashier, opening_cash: openingCash }
    const id = pos.openShift(request)
    expect(pos.getExpectedCash(cashier)).toEqual({ opening_cash: openingCash,
      cash_sales: 0, cash_returns: 0, cash_in: 0, cash_out: 0, expected_amount: openingCash })
    const before = snapshot()
    expect(pos.openShift(request)).toBe(id)
    expect(snapshot()).toEqual(before)
    assertClosedUnchanged()
    expect(pos.getOpenShift(cashier)?.id).toBe(id)
    return id
  }

  function close(cashier: string, id: string, time: string, amount: number): void {
    vi.setSystemTime(new Date(time))
    const before = snapshot()
    expect(pos.getShiftReport(cashier)?.cash_breakdown.expected_amount).toBe(amount)
    expect(snapshot()).toEqual(before)
    const comment = 'Synthetic counted drawer ' + time.slice(0, 10)
    const result = pos.closeShift(cashier, amount, comment, id)
    expect(db.prepare('SELECT * FROM shifts WHERE id = ?').get(id)).toMatchObject({
      cashier_id: cashier, status: 'closed', closing_cash: amount, expected_cash: amount,
      cash_variance: 0, closed_at: time,
    })
    expect(pos.getOpenShift(cashier)).toBeNull()
    expect(pos.getShiftReport(cashier)).toBeNull()
    expect(pos.getExpectedCash(cashier)).toBeNull()
    closed.push({ id, cashier, amount, comment, result, evidence: shiftEvidence(id) })
    assertClosedUnchanged()
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-29T07:00:00.000Z'))
    root = mkdtempSync(path.join(tmpdir(), 'forsage-tire-closed-month-'))
    connect()
    closed = []
    for (const [id, role] of [[CASHIER_A, 'cashier'], [CASHIER_B, 'cashier'], [WORKER, 'tire_worker']]) {
      db.prepare(`INSERT INTO staff_users
        (id,tenant_id,full_name,role,is_active,base_rate,rate_period,created_at,updated_at)
        VALUES (?,?,?,?,1,0,'day',?,?)`).run(id, tenant, id, role, SALE_TIME, SALE_TIME)
    }
    productId = new LocalCatalogRepository(db).upsertProduct({ id: 'closed-tire-service',
      sku: 'POS-TIRE-SERVICE', name: 'Шиномонтаж', is_service: true,
      retail_price: 18000, purchase_price: 0, qty_on_hand: 0 }).id
    staff.createCommissionRule({ user_id: WORKER, rule_type: 'tire_service', pct_from_revenue: 35, pct_from_profit: 0 })
  })

  afterEach(() => {
    try { db?.close() } finally {
      vi.useRealTimers()
      if (root) {
        const resolved = path.resolve(root)
        if (path.dirname(resolved) === path.resolve(tmpdir())
          && path.basename(resolved).startsWith('forsage-tire-closed-month-')
          && realpathSync(resolved) === resolved) rmSync(resolved, { recursive: true, force: true })
      }
    }
  })

  it('preserves four closed drawers while the current cashier pays and refunds the original off-duty worker', () => {
    const saleShift = open(CASHIER_A, '2026-09-29T07:00:00.000Z', 20000)
    vi.setSystemTime(new Date(SALE_TIME))
    const checkout: LocalSaleCheckoutInput = { tenant_id: tenant, client_operation_id: 'closed-tire-sale',
      cashier_id: CASHIER_A, manager_id: WORKER, shift_id: saleShift, is_fiscal: false,
      notes: 'Actual worker, independent of the cashier duty',
      items: [{ product_id: productId, qty: 2, unit_price: 18000 }], payments: [{ method: 'cash', amount: 36000 }] }
    const sale = pos.checkout(checkout)
    const originalReceipt = staff.tireServiceReport(WORK_DAY).receipts[0]
    expect(originalReceipt).toMatchObject({ id: sale.sale_id, employee_id: WORKER, cashier_id: CASHIER_A,
      services_qty: 2, service_revenue: 36000, cash_register_received: 36000, commission_earned: 12600 })
    expect(pos.getShiftReport(CASHIER_A)).toMatchObject({ total_sales: 1, gross_revenue: 36000,
      refund_total: 0, total_revenue: 36000, payment_received_total: 36000, payment_net_total: 36000,
      cash_breakdown: { opening_cash: 20000, cash_sales: 36000, cash_returns: 0, cash_out: 0, expected_amount: 56000 } })
    close(CASHIER_A, saleShift, '2026-09-29T18:00:00.000Z', 56000)
    const septemberClosed = snapshot()
    restart()
    expect(snapshot()).toEqual(septemberClosed)

    vi.setSystemTime(new Date(PAYOUT_TIME))
    const forbidden = { operation_id: 'closed-tire-blocked-payout', employee_id: WORKER,
      method: 'cash' as const, fund_source: 'cashbox' as const,
      shift_id: saleShift, work_date: WORK_DAY, user_id: CASHIER_B }
    expect(staff.tireServiceReport(WORK_DAY).data[0].salary_ready).toBe(true)
    expect(() => staff.dailyPayout(forbidden)).toThrow('Касова зміна не відкрита')
    expect(snapshot()).toEqual(septemberClosed)
    const payoutShift = open(CASHIER_B, '2026-10-01T07:30:00.000Z', 56000)
    vi.setSystemTime(new Date(PAYOUT_TIME))
    const beforePayout = snapshot()
    expect(() => staff.dailyPayout(forbidden)).toThrow('Касова зміна не відкрита')
    expect(snapshot()).toEqual(beforePayout)
    const payout = { ...forbidden, operation_id: 'closed-tire-payout', shift_id: payoutShift }
    const paid = staff.dailyPayout(payout)
    expect(paid).toMatchObject({ amount: 12600, payment: { employee_id: WORKER, amount: 12600,
      period: '2026-09', work_date: WORK_DAY, shift_id: payoutShift, created_by: CASHIER_B, created_at: PAYOUT_TIME } })
    expect(pos.getShiftReport(CASHIER_B)).toMatchObject({ total_sales: 0, gross_revenue: 0, refund_total: 0,
      total_revenue: 0, payment_received_total: 0, payment_net_total: 0,
      cash_breakdown: { opening_cash: 56000, cash_sales: 0, cash_returns: 0, cash_out: 12600, expected_amount: 43400 } })
    assertClosedUnchanged()
    close(CASHIER_B, payoutShift, '2026-10-01T18:00:00.000Z', 43400)
    const payoutClosed = snapshot()
    restart()
    expect(snapshot()).toEqual(payoutClosed)
    expect(staff.dailyPayout(payout)).toEqual(paid)
    expect(pos.checkout(checkout)).toEqual(sale)
    expect(snapshot()).toEqual(payoutClosed)

    const line = pos.getSaleForReturn(sale.sale_id).items[0]
    const returned: Array<{ request: any; result: any; shift: string; time: string }> = []
    for (const [index, time, openingCash, closingCash] of [
      [0, FIRST_RETURN_TIME, 43400, 25400], [1, FINAL_RETURN_TIME, 25400, 7400],
    ] as const) {
      const day = time.slice(0, 10)
      const shift = open(CASHIER_B, day + 'T07:30:00.000Z', openingCash)
      vi.setSystemTime(new Date(time))
      const request = { tenant_id: tenant, client_operation_id: 'closed-tire-return-' + index,
        sale_id: sale.sale_id, cashier_id: CASHIER_B, approved_by: CASHIER_B, shift_id: shift,
        is_fiscal: false, refund_method: 'cash', reason: 'other', stock_action: 'return_to_stock',
        items: [{ sale_item_id: line.id, product_id: productId, quantity: 1, condition: 'good' }] }
      const result = pos.createReturn(request)
      expect(result).toMatchObject({ sale_id: sale.sale_id, refund_kopecks: 18000, created_at: time })
      returned.push({ request, result, shift, time })
      expect(db.prepare('SELECT shift_id, approved_by, created_at FROM customer_returns WHERE id = ?').get(result.id))
        .toEqual({ shift_id: shift, approved_by: CASHIER_B, created_at: time })
      expect(pos.getShiftReport(CASHIER_B)).toMatchObject({ shift: { id: shift, cashier_id: CASHIER_B },
        total_sales: 0, gross_revenue: 0, refund_total: 18000, total_revenue: -18000,
        payment_received_total: 0, payment_refunded_total: 18000, payment_net_total: -18000,
        unassigned_refunds_count: 0, refunds_by_method: { cash: 18000 },
        cash_breakdown: { opening_cash: openingCash, cash_sales: 0, cash_returns: 18000,
          cash_in: 0, cash_out: 0, expected_amount: closingCash } })
      expect(pos.getSale(sale.sale_id).status).toBe(index === 0 ? 'completed' : 'returned')
      const beforeRead = snapshot()
      expect(staff.tireServiceReport(WORK_DAY).receipts).toEqual([originalReceipt])
      expect(staff.tireServiceReport(WORK_DAY).data[0]).toMatchObject({ employee_id: WORKER,
        service_revenue: 36000, commission_earned: 12600, paid: 12600, balance: 0, cash_pending: 0 })
      expect(staff.tireServiceReport(day).data[0]).toMatchObject({ employee_id: WORKER,
        commission_earned: -6300, earned: -6300, balance: -6300, due: 0, cash_pending: 0 })
      expect(snapshot()).toEqual(beforeRead)
      assertClosedUnchanged()
      close(CASHIER_B, shift, day + 'T18:00:00.000Z', closingCash)
      const committed = snapshot()
      restart()
      expect(snapshot()).toEqual(committed)
      expect(pos.checkout(checkout)).toEqual(sale)
      expect(staff.dailyPayout(payout)).toEqual(paid)
      for (const prior of returned) expect(pos.createReturn(prior.request)).toEqual(prior.result)
      assertClosedUnchanged()
      expect(snapshot()).toEqual(committed)
    }

    expect(db.prepare(`SELECT cashier_id, opening_cash, closing_cash, expected_cash, cash_variance, status
      FROM shifts ORDER BY opened_at`).all()).toEqual([
      { cashier_id: CASHIER_A, opening_cash: 20000, closing_cash: 56000, expected_cash: 56000, cash_variance: 0, status: 'closed' },
      { cashier_id: CASHIER_B, opening_cash: 56000, closing_cash: 43400, expected_cash: 43400, cash_variance: 0, status: 'closed' },
      { cashier_id: CASHIER_B, opening_cash: 43400, closing_cash: 25400, expected_cash: 25400, cash_variance: 0, status: 'closed' },
      { cashier_id: CASHIER_B, opening_cash: 25400, closing_cash: 7400, expected_cash: 7400, cash_variance: 0, status: 'closed' },
    ])
    expect(db.prepare('SELECT type, amount, shift_id, user_id, created_at FROM cash_operations ORDER BY created_at, id').all())
      .toEqual([
        { type: 'sale_cash', amount: 36000, shift_id: saleShift, user_id: CASHIER_A, created_at: SALE_TIME },
        { type: 'salary_payout', amount: 12600, shift_id: payoutShift, user_id: CASHIER_B, created_at: PAYOUT_TIME },
        ...returned.map(item => ({ type: 'return_cash', amount: 18000, shift_id: item.shift, user_id: CASHIER_B, created_at: item.time })),
      ])
    expect(db.prepare(`SELECT employee_id, amount, source, work_date, period, created_at, created_by
      FROM salary_payments ORDER BY created_at, id`).all()).toEqual([
      { employee_id: WORKER, amount: 12600, source: 'commission', work_date: WORK_DAY, period: '2026-09', created_at: SALE_TIME, created_by: CASHIER_A },
      { employee_id: WORKER, amount: 12600, source: 'daily_payout', work_date: WORK_DAY, period: '2026-09', created_at: PAYOUT_TIME, created_by: CASHIER_B },
      ...returned.map(item => ({ employee_id: WORKER, amount: -6300, source: 'commission_reversal', work_date: item.time.slice(0, 10),
        period: '2026-10', created_at: item.time, created_by: CASHIER_B })),
    ])
    expect(staff.salarySummary('2026-09')[0]).toMatchObject({ employee_id: WORKER, earned: 12600, paid: 12600, balance: 0 })
    expect(staff.salarySummary('2026-10')[0]).toMatchObject({ employee_id: WORKER, earned: -12600, paid: 0, balance: -12600 })
    expect(db.prepare('SELECT * FROM shifts WHERE cashier_id = ?').all(WORKER)).toEqual([])
    expect(db.prepare('SELECT * FROM inventory_movements WHERE product_id = ?').all(productId)).toEqual([])
    expect(db.prepare("SELECT COUNT(*) n FROM sync_outbox WHERE operation_type = 'shift.opened'").get()).toEqual({ n: 4 })
    expect(db.prepare("SELECT COUNT(*) n FROM sync_outbox WHERE operation_type = 'shift.closed'").get()).toEqual({ n: 4 })
    const settled = snapshot()
    expect(() => staff.tireCashHandover({ operation_id: 'closed-tire-forbidden-handover',
      employee_id: WORKER, user_id: CASHIER_B, shift_id: returned[1].shift, work_date: WORK_DAY, amount: 36000 }))
      .toThrow('Повторне внесення заборонено')
    expect(snapshot()).toEqual(settled)
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
