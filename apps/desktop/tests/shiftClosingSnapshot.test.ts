import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { readOpenCashBalance, readOpenCashBreakdown, cashSum } from '../src/repositories/cashBalance'

describe('shift closing uses validated snapshot cash', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository, shift: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-closing-snapshot-'))
    db = new LocalDatabase(root); pos = new LocalPosRepository(db)
    shift = pos.openShift({ cashier_id: 'cashier', opening_cash: 10000 })
  })
  afterEach(() => {
    vi.restoreAllMocks(); db.close()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-closing-snapshot-')) rmSync(root, { recursive: true, force: true })
  })
  function op(type: string, amount: number | string, shop = tenant, shiftId = shift, deleted: string | null = null) {
    const id = randomUUID(), now = new Date().toISOString()
    db.prepare('INSERT INTO cash_operations(id,tenant_id,shift_id,type,amount,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, shop, shiftId, type, amount, now, now, deleted)
    return id
  }
  it('counts every drawer operation once; not card/transfer/account turnover', () => {
    op('sale_cash', 7000); op('return_cash', 1200); op('cash_in', 1300)
    op('cash_out', 500); op('salary_payout', 600); op('supplier_payment', 700)
    const expected = { opening_cash: 10000, cash_sales: 7000, cash_returns: 1200, cash_in: 1300, cash_out: 1800, expected_amount: 15300 }
    expect(pos.getExpectedCash('cashier')).toEqual(expected)
    expect(pos.getShiftReport('cashier')?.cash_breakdown).toEqual(expected)
    expect(readOpenCashBalance(db, tenant, shift)).toBe(15300)
  })
  it('does not count another tenant, another shift or deleted operation', () => {
    const other = pos.openShift({ cashier_id: 'other' })
    op('cash_in', 1, 'foreign'); op('cash_out', 3, tenant, other); op('cash_in', 4, tenant, shift, new Date().toISOString())
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(10000)
  })
  it('does not truncate a shift with more than a thousand operations', () => {
    db.transaction(() => { for (let i = 0; i < 1501; i++) op('cash_in', 1) })
    expect(pos.getShiftReport('cashier')?.cash_breakdown.cash_in).toBe(1501)
  })
  it.each([-1, 0.5, 'broken', Number.MAX_SAFE_INTEGER + 1])('blocks bad historical amount %s without modifying the shift', value => {
    op('cash_in', value)
    const before = db.prepare('SELECT * FROM shifts WHERE id=?').get(shift)
    expect(() => pos.getExpectedCash('cashier')).toThrow()
    expect(() => pos.getShiftReport('cashier')).toThrow()
    expect(() => pos.reconcileShift('cashier', 0, 'test')).toThrow()
    expect(() => pos.closeShift('cashier', 0, 'test', shift, tenant, 'owner')).toThrow()
    expect(db.prepare('SELECT * FROM shifts WHERE id=?').get(shift)).toEqual(before)
    expect(db.prepare("SELECT COUNT(*) n FROM sync_outbox WHERE operation_type='shift.closed'").get()).toEqual({ n: 0 })
  })
  it('does not silently ignore a correction with unknown direction', () => {
    op('correction', 100)
    expect(() => readOpenCashBalance(db, tenant, shift)).toThrow('Некоректні касові')
  })
  it.each([-1, 0.5, 'bad', Number.MAX_SAFE_INTEGER + 1])('rejects invalid opening cash %s', amount => {
    db.prepare('UPDATE shifts SET opening_cash=? WHERE id=?').run(amount, shift)
    expect(() => pos.getExpectedCash('cashier')).toThrow()
  })
  it('rejects unsafe bucket totals rather than rounding a kopeck', () => {
    op('cash_in', Number.MAX_SAFE_INTEGER); op('cash_in', 1)
    expect(() => pos.getExpectedCash('cashier')).toThrow()
  })
  it('preserves negative expected cash for the owner reconciliation and stored close', () => {
    op('cash_out', 11000)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(-1000)
    expect(() => pos.closeShift('cashier', 0, null, shift)).toThrow('не сходиться')
    pos.reconcileShift('cashier', 0, 'Історична нестача')
    expect(db.prepare('SELECT expected_cash,cash_variance FROM shifts WHERE id=?').get(shift)).toEqual({expected_cash: -1000, cash_variance: 1000})
    pos.closeShift('cashier', 0, 'Історична нестача', shift, tenant, 'owner')
    expect(db.prepare('SELECT expected_cash,cash_variance,status FROM shifts WHERE id=?').get(shift)).toEqual({expected_cash: -1000, cash_variance: 1000, status: 'closed'})
  })
  it('reports money and sales from one WAL snapshot despite a concurrent writer', () => {
    const writerDb = new LocalDatabase(root), writer = new LocalPosRepository(writerDb)
    const original = pos.getOpenShift.bind(pos)
    vi.spyOn(pos, 'getOpenShift').mockImplementationOnce((cashier, shop) => {
      const result = original(cashier, shop)
      writer.createCashOperation({ shift_id: shift, type: 'in', amount: 150 })
      return result
    })
    try {
      expect(pos.getShiftReport('cashier')?.cash_breakdown.expected_amount).toBe(10000)
      expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(10150)
    } finally { writerDb.close() }
  })
  it('rechecks the ledger under the close transaction after a stale preview', () => {
    const preview = pos.getShiftReport('cashier')!
    pos.createCashOperation({ shift_id: shift, type: 'in', amount: 100 })
    expect(() => pos.closeShift('cashier', preview.cash_breakdown.expected_amount, null, shift)).toThrow('не сходиться')
    expect(pos.getOpenShift('cashier')?.id).toBe(shift)
    pos.closeShift('cashier', 10100, null, shift)
    expect(pos.closeShift('cashier', 10100, null, shift)).toEqual({ ok: true, id: shift })
  })
  it('does not expose closed or foreign shifts', () => {
    expect(pos.getExpectedCash('cashier', 'other')).toBeNull()
    expect(() => readOpenCashBreakdown(db, 'other', shift)).toThrow()
    pos.closeShift('cashier', 10000, null, shift)
    expect(pos.getShiftReport('cashier')).toBeNull()
    expect(() => readOpenCashBalance(db, tenant, shift)).toThrow()
  })
  it('reading does not write and arithmetic remains exact with signed cancellation', () => {
    const before = db.prepare('SELECT total_changes() n').get()
    pos.getShiftReport('cashier'); pos.getExpectedCash('cashier')
    expect(db.prepare('SELECT total_changes() n').get()).toEqual(before)
    expect(cashSum(Number.MAX_SAFE_INTEGER, 1, -1)).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => cashSum(Number.MAX_SAFE_INTEGER, 1)).toThrow()
  })
})
