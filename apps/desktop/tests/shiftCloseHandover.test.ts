import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalPosRepository } from '../src/repositories/posRepository'

// 24.11.2026 (рішення власника): при закритті лишають розмін, решту здають власнику — і це записується.
// До того видачу ніхто не записував: уся сума переходила на початок наступної зміни (37 986 грн при виручці 21 000).
describe('closing a shift: change stays, the rest is handed to the owner', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository, cashier: string, shift: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-shift-handover-'))
    db = new LocalDatabase(root); pos = new LocalPosRepository(db); cashier = randomUUID()
    const ts = new Date().toISOString()
    db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(cashier, DEFAULT_TENANT_ID, 'Олексій', 'cashier', ts, ts)
    shift = pos.openShift({ cashier_id: cashier, opening_cash: 50000 })
    // Готівкова виручка зміни: 2 100 грн.
    db.prepare("INSERT INTO cash_operations(id,tenant_id,shift_id,user_id,type,source,amount,notes,created_at,updated_at) VALUES (?,?,?,?,'sale_cash','cashbox',?,?,?,?)")
      .run(randomUUID(), DEFAULT_TENANT_ID, shift, cashier, 210000, 'продаж', ts, ts)
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-shift-handover-')) rmSync(root, { recursive: true, force: true })
  })
  const row = () => db.prepare('SELECT status, closing_cash, expected_cash, cash_variance FROM shifts WHERE id = ?').get(shift)
  const outs = () => db.prepare("SELECT amount, notes, user_id FROM cash_operations WHERE shift_id = ? AND type = 'cash_out'").all(shift)

  it('records the handover as a cash-out in the same step and leaves only the change in the shift', () => {
    pos.closeShift(cashier, 260000, null, shift, DEFAULT_TENANT_ID, 'cashier', cashier, 50000)
    expect(outs()).toEqual([{ amount: 210000, notes: 'Здано власнику при закритті зміни', user_id: cashier }])
    expect(row()).toEqual({ status: 'closed', closing_cash: 50000, expected_cash: 50000, cash_variance: 0 })
    const events = (db.prepare("SELECT operation_type FROM sync_outbox WHERE operation_type IN ('cash_operation.created', 'shift.closed')").all() as Array<{ operation_type: string }>).map(event => event.operation_type)
    expect(events.sort()).toEqual(['cash_operation.created', 'shift.closed'])
  })

  it('a repeat of the same closing changes nothing; different numbers under the same shift are refused', () => {
    const first = pos.closeShift(cashier, 260000, null, shift, DEFAULT_TENANT_ID, 'cashier', cashier, 50000)
    expect(pos.closeShift(cashier, 260000, null, shift, DEFAULT_TENANT_ID, 'cashier', cashier, 50000)).toEqual(first)
    expect(outs()).toHaveLength(1)
    expect(() => pos.closeShift(cashier, 260000, null, shift, DEFAULT_TENANT_ID, 'cashier', cashier, 0)).toThrow('інші дані')
  })

  it('keeping everything or handing over everything both work; keeping more than there is — refused', () => {
    expect(() => pos.closeShift(cashier, 260000, null, shift, DEFAULT_TENANT_ID, 'cashier', cashier, 260001)).toThrow('На розмін не можна лишити більше')
    expect(() => pos.closeShift(cashier, 260000, null, shift, DEFAULT_TENANT_ID, 'cashier', cashier, -1)).toThrow()
    expect(pos.getOpenShift(cashier)?.id).toBe(shift)
    pos.closeShift(cashier, 260000, null, shift, DEFAULT_TENANT_ID, 'cashier', cashier, 0)
    expect(outs()).toEqual([{ amount: 260000, notes: 'Здано власнику при закритті зміни', user_id: cashier }])
    expect(row()).toMatchObject({ closing_cash: 0, expected_cash: 0, cash_variance: 0 })
  })

  it('the cashier still cannot close with a wrong count; the owner shortage is kept as the variance', () => {
    expect(() => pos.closeShift(cashier, 250000, null, shift, DEFAULT_TENANT_ID, 'cashier', cashier, 50000)).toThrow('Сума не сходиться. Очікується 2600.00')
    pos.closeShift(cashier, 250000, 'бракує 100 грн', shift, DEFAULT_TENANT_ID, 'owner', cashier, 50000)
    // Перераховано 2 500 при очікуваних 2 600: здано 2 000, лишилось 500, нестача 100 видна.
    expect(outs()[0]).toMatchObject({ amount: 200000 })
    expect(row()).toEqual({ status: 'closed', closing_cash: 50000, expected_cash: 60000, cash_variance: -10000 })
  })

  it('without the change amount everything works as before (old windows, closing from the web)', () => {
    pos.closeShift(cashier, 260000, null, shift)
    expect(outs()).toEqual([])
    expect(row()).toEqual({ status: 'closed', closing_cash: 260000, expected_cash: 260000, cash_variance: 0 })
  })
})
