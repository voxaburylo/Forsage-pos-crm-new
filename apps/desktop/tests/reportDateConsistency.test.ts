import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { localAnalytics } from '../src/repositories/localAnalytics'

// Independent calendar oracle: Kyiv was UTC+03 on this October business day.
// The historic database also contains timestamps with offsets and microseconds.
const period = { date_from: '2026-10-04T21:00:00.000Z', date_to: '2026-10-05T20:59:59.999Z' }
const kinds = ['dashboard', 'sold', 'period', 'abc', 'staff'] as const
type Kind = typeof kinds[number]

describe('reports agree on actual instants and one read snapshot', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository, product: string, shift: string
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-05T10:00:00Z'))
    root = mkdtempSync(path.join(tmpdir(), 'forsage-report-dates-'))
    db = new LocalDatabase(root); pos = new LocalPosRepository(db)
    db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('seller', tenant, 'Test seller', 'cashier', new Date().toISOString(), new Date().toISOString())
    shift = pos.openShift({ cashier_id: 'seller', opening_cash: 10000 })
    product = new LocalCatalogRepository(db).saveProduct({ id: randomUUID(), sku: 'DATE-TEST',
      name: 'Test product', qty_on_hand: 10, purchase_price: 40, retail_price: 100 }).id
  })
  afterEach(() => {
    vi.restoreAllMocks(); db.close(); vi.useRealTimers()
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-report-dates-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })
  function sell(at: string) {
    const result = pos.checkout({ cashier_id: 'seller', shift_id: shift,
      items: [{ product_id: product, qty: 1, unit_price: 100 }], payments: [{ method: 'cash', amount: 100 }] })
    db.prepare('UPDATE sales SET completed_at=?,created_at=? WHERE id=?').run(at, at, result.sale_id)
    return result.sale_id
  }
  function amount(kind: Kind, range = period, workDate = '2026-10-05') {
    if (kind === 'dashboard') return pos.dashboardSummary(range).analytics.total_revenue
    if (kind === 'sold') return pos.soldItemsReport(range).reduce((sum, row) => sum + row.net_revenue, 0)
    if (kind === 'period') return pos.salesPeriodReport(range).net_revenue
    const rows = localAnalytics(db, { kind, from: range.date_from, to: range.date_to,
      startDate: workDate, endDate: workDate })
    // ABC measures margin, not revenue. The independent cost is 40 per item.
    return kind === 'abc' ? rows.reduce((sum, row) => sum + row.profit, 0)
      : rows.reduce((sum, row) => sum + row.total_revenue, 0)
  }
  const boundaries = [
    ['2026-10-04T23:59:59.999000+03:00', false],
    ['2026-10-05T00:00:00.000000+03:00', true],
    ['2026-10-04T21:00:00Z', true],
    ['2026-10-05T23:59:59.999000+03:00', true],
    ['2026-10-06T00:00:00.000000+03:00', false],
  ] as const
  describe.each(kinds)('%s', kind => {
    it.each(boundaries)('selects a legacy sale at %s correctly', (at, included) => {
      sell(at)
      expect(amount(kind)).toBe(included ? (kind === 'abc' ? 60 : 100) : 0)
    })
    it.each(boundaries)('selects a legacy return at %s on its own date', (at, included) => {
      const sale = sell('2026-10-03T10:00:00.000Z')
      const item = pos.getSaleForReturn(sale).items[0]
      const returned = pos.createReturn({ sale_id: sale, shift_id: shift, approved_by: 'seller',
        refund_method: 'cash', stock_action: 'return_to_stock',
        items: [{ sale_item_id: item.id, product_id: product, quantity: 1 }] })
      db.prepare('UPDATE customer_returns SET created_at=? WHERE id=?').run(at, returned.id)
      expect(amount(kind)).toBe(included ? (kind === 'abc' ? -60 : -100) : 0)
    })
    it('normalizes offset request bounds before querying', () => {
      sell('2026-10-04T21:30:00.000Z')
      expect(amount(kind, { date_from: '2026-10-05T00:00:00+03:00', date_to: '2026-10-05T23:59:59.999+03:00' }))
        .toBe(kind === 'abc' ? 60 : 100)
    })
    it.each(['2026-10-04', '2026-02-30T10:00:00Z', '2026-10-04T24:00:00Z', 'bad'])('rejects ambiguous or invalid range %s', from => {
      expect(() => amount(kind, { ...period, date_from: from })).toThrow(/період/)
    })
    it('rejects reversed bounds instead of showing a zero report', () => {
      expect(() => amount(kind, { date_from: period.date_to, date_to: period.date_from })).toThrow(/період/)
    })
    it.each([
      { day: '2026-03-29', start: '2026-03-28T22:00:00Z', end: '2026-03-29T20:59:59.999Z',
        stamps: ['2026-03-29T00:00:00+02:00', '2026-03-29T23:59:59.999+03:00'] },
      { day: '2026-10-25', start: '2026-10-24T21:00:00Z', end: '2026-10-25T21:59:59.999Z',
        stamps: ['2026-10-25T03:30:00+03:00', '2026-10-25T03:30:00+02:00'] },
    ])('keeps the complete Kyiv clock-change day $day', ({ day, start, end, stamps }) => {
      for (const stamp of stamps) sell(stamp)
      sell(new Date(Date.parse(start) - 1).toISOString())
      sell(new Date(Date.parse(end) + 1).toISOString())
      expect(amount(kind, { date_from: start, date_to: end }, day)).toBe(kind === 'abc' ? 120 : 200)
    })
  })
  it('compares an order pickup deadline as an instant', () => {
    const now = new Date().toISOString()
    db.prepare('INSERT INTO customer_orders(id,tenant_id,status,pickup_deadline_at,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('past', tenant, 'new', '2026-10-05T12:00:00+03:00', now, now)
    expect(pos.dashboardSummary(period).overdue_count).toBe(1)
  })
  it('dashboard reads stock and receipts from one non-writing WAL snapshot', () => {
    const sale = sell('2026-10-05T10:00:00.000Z')
    const writer = new LocalDatabase(root), prepare = db.prepare.bind(db)
    let changed = false
    vi.spyOn(db, 'prepare').mockImplementation(sql => {
      if (!changed && sql.includes('FROM sales s') && sql.includes('zero_cost_lines')) {
        changed = true
        writer.transaction(() => {
          writer.prepare('UPDATE sales SET total=200,cash_amount=200 WHERE id=?').run(sale)
          writer.prepare('UPDATE sale_items SET unit_price=200,total=200 WHERE sale_id=?').run(sale)
          writer.prepare('UPDATE products SET qty_on_hand=77 WHERE id=?').run(product)
        })
      }
      return prepare(sql)
    })
    try {
      db.exec('PRAGMA query_only=ON')
      const first = pos.dashboardSummary(period)
      expect(changed).toBe(true)
      expect(first.inventory.purchase_value).toBe(360)
      expect(first.analytics.total_revenue).toBe(100)
      const next = pos.dashboardSummary(period)
      expect(next.inventory.purchase_value).toBe(3080)
      expect(next.analytics.total_revenue).toBe(200)
    } finally { db.exec('PRAGMA query_only=OFF'); writer.close() }
  })
})
