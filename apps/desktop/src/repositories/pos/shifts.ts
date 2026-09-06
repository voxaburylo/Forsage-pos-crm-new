/**
 * Зміни й готівка: відкриття, звірка, закриття, касові операції.
 *
 * Частина каси, винесена з `posRepository.ts` (3431 рядок) — див.
 * `REFACTOR_PLAN.md`, ітерація 4. Клас поділено ланцюжком успадкування:
 * кожен шар кличе лише те, що лежить нижче, тому жоден виклик `this.` не
 * довелося переписувати. Методи перенесені рядок у рядок.
 */
import { DEFAULT_TENANT_ID } from '../../db/localTypes'
import { money, nowIso } from './posShared'
import { randomUUID } from 'node:crypto'
import { LocalPosFiscalGuards } from './fiscalGuards'
import { readOpenCashBalance } from '../cashBalance'

export class LocalPosShifts extends LocalPosFiscalGuards {
  openShift(input: {
    tenant_id?: string
    cashier_id: string
    opening_cash?: number
    notes?: string | null
  }): string {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const existing = this.findOpenShift(input.cashier_id, tenantId)
    if (existing) return existing

    const timestamp = nowIso()
    const shiftId = randomUUID()
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO shifts (
          id, tenant_id, cashier_id, status, opening_cash, opened_at,
          notes, dirty_at, created_at, updated_at
        )
        VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)
      `).run(
        shiftId,
        tenantId,
        input.cashier_id,
        input.opening_cash ?? 0,
        timestamp,
        input.notes ?? null,
        timestamp,
        timestamp,
        timestamp,
      )

      this.addOutbox(
        tenantId,
        'shift',
        shiftId,
        'shift.opened',
        { id: shiftId, cashier_id: input.cashier_id, opening_cash: input.opening_cash ?? 0 },
        timestamp,
      )
    })

    return shiftId
  }

  findOpenShift(cashierId: string, tenantId = DEFAULT_TENANT_ID): string | null {
    return this.getOpenShift(cashierId, tenantId)?.id ?? null
  }

  getOpenShift(cashierId: string, tenantId = DEFAULT_TENANT_ID): {
    id: string
    cashier_id: string
    status: 'open'
    opening_cash: number
    closing_cash: number | null
    expected_cash: number | null
    cash_variance: number | null
    opened_at: string
    closed_at: string | null
    notes: string | null
  } | null {
    const row = this.db.prepare(`
      SELECT id, cashier_id, status, opening_cash, closing_cash, expected_cash,
             cash_variance, opened_at, closed_at, notes
      FROM shifts
      WHERE tenant_id = ?
        AND cashier_id = ?
        AND status = 'open'
        AND deleted_at IS NULL
      ORDER BY opened_at DESC
      LIMIT 1
    `).get(tenantId, cashierId) as {
      id: string
      cashier_id: string
      status: 'open'
      opening_cash: number
      closing_cash: number | null
      expected_cash: number | null
      cash_variance: number | null
      opened_at: string
      closed_at: string | null
      notes: string | null
    } | undefined
    return row ?? null
  }

  createCashOperation(input: {
    tenant_id?: string
    shift_id: string
    user_id?: string | null
    type: 'in' | 'out'
    amount: number
    note?: string | null
    source?: string
  }): any {
    return this.db.transaction(() => this.createCashOperationInTransaction(input))
  }

  private createCashOperationInTransaction(input: Parameters<LocalPosShifts['createCashOperation']>[0]): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const amount = money(input.amount)
    if (amount <= 0) throw new Error('Вкажіть суму більше нуля')
    const shift = this.db.prepare(`
      SELECT id FROM shifts
      WHERE id = ? AND tenant_id = ? AND status = 'open' AND deleted_at IS NULL
    `).get(input.shift_id, tenantId) as { id: string } | undefined
    if (!shift) throw new Error('Касову зміну не знайдено або вже закрито')
    const timestamp = nowIso()
    const id = randomUUID()
    const dbType = input.type === 'in' ? 'cash_in' : 'cash_out'
    this.assertCashOperationAllowed(tenantId, input.shift_id, dbType, amount)
    this.db.prepare(`
      INSERT INTO cash_operations (
        id, tenant_id, shift_id, user_id, type, source, amount, notes,
        dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, tenantId, input.shift_id, input.user_id ?? null, dbType,
      input.source ?? 'cashbox', amount, input.note ?? null,
      timestamp, timestamp, timestamp,
    )
    this.addOutbox(tenantId, 'cash_operation', id, 'cash_operation.created', {
      id, shift_id: input.shift_id, type: input.type, amount,
      note: input.note ?? null, source: input.source ?? 'cashbox',
      user_id: input.user_id ?? null,
    }, timestamp)
    return {
      id, shift_id: input.shift_id, type: input.type, amount,
      note: input.note ?? null, created_by: input.user_id ?? 'local', created_at: timestamp,
    }
  }

  listCashOperations(shiftId: string, tenantId = DEFAULT_TENANT_ID): any[] {
    const rows = this.db.prepare(`
      SELECT id, shift_id, user_id, type, amount, notes, created_at
      FROM cash_operations
      WHERE shift_id = ? AND tenant_id = ? AND deleted_at IS NULL AND type IN ('cash_in', 'cash_out')
      ORDER BY created_at DESC
    `).all(shiftId, tenantId) as any[]
    return rows.map((row) => ({
      id: row.id,
      shift_id: row.shift_id,
      type: row.type === 'cash_in' ? 'in' : 'out',
      amount: Number(row.amount),
      note: row.notes ?? null,
      created_by: row.user_id ?? 'local',
      created_at: row.created_at,
    }))
  }

  getCashOperationSummary(shiftId: string, tenantId = DEFAULT_TENANT_ID): {
    total_in: number
    total_out: number
    net: number
  } {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'cash_in' THEN amount ELSE 0 END), 0) AS total_in,
        COALESCE(SUM(CASE WHEN type = 'cash_out' THEN amount ELSE 0 END), 0) AS total_out
      FROM cash_operations
      WHERE shift_id = ? AND tenant_id = ?
    `).get(shiftId, tenantId) as { total_in: number; total_out: number }
    const totalIn = Number(row?.total_in ?? 0)
    const totalOut = Number(row?.total_out ?? 0)
    return { total_in: totalIn, total_out: totalOut, net: totalIn - totalOut }
  }

  getExpectedCash(cashierId: string, tenantId = DEFAULT_TENANT_ID): {
    opening_cash: number
    cash_sales: number
    cash_returns: number
    cash_in: number
    cash_out: number
    expected_amount: number
  } | null {
    const shift = this.getOpenShift(cashierId, tenantId)
    if (!shift) return null
    const rows = this.db.prepare(`
      SELECT type, SUM(amount) AS total
      FROM cash_operations
      WHERE tenant_id = ? AND shift_id = ? AND deleted_at IS NULL
      GROUP BY type
    `).all(tenantId, shift.id) as Array<{ type: string; total: number }>
    const by: Record<string, number> = {}
    for (const r of rows) by[r.type] = Number(r.total) || 0
    const cash_sales = by['sale_cash'] ?? 0
    const cash_returns = by['return_cash'] ?? 0
    const cash_in = by['cash_in'] ?? 0
    const cash_out = (by['cash_out'] ?? 0) + (by['salary_payout'] ?? 0) + (by['supplier_payment'] ?? 0)
    const expected = shift.opening_cash + cash_sales + cash_in - cash_returns - cash_out
    return {
      opening_cash: shift.opening_cash,
      cash_sales,
      cash_returns,
      cash_in,
      cash_out,
      expected_amount: expected,
    }
  }

  getShiftReport(cashierId: string, tenantId = DEFAULT_TENANT_ID): {
    shift: NonNullable<ReturnType<LocalPosShifts['getOpenShift']>>
    total_sales: number
    total_revenue: number
    payment_received_total: number
    by_method: { cash: number; card: number; transfer: number; account: number; debt: number }
    sales: Array<{
      id: string
      sale_number: string
      total: number
      payment_method: string
      status: string
      completed_at: string
    }>
  } | null {
    const shift = this.getOpenShift(cashierId, tenantId)
    if (!shift) return null
    const sales = this.db.prepare(`
      SELECT s.id, s.sale_number, s.total, s.payment_method, s.status, s.completed_at,
             s.cash_amount, s.card_amount, s.transfer_amount, s.debt_amount,
             EXISTS (
               SELECT 1 FROM customer_orders o
               WHERE o.tenant_id = s.tenant_id
                 AND o.sale_id = s.id
                 AND o.deleted_at IS NULL
             ) AS is_order_sale
      FROM sales s
      WHERE s.tenant_id = ? AND s.shift_id = ? AND s.deleted_at IS NULL
      ORDER BY s.completed_at ASC
    `).all(tenantId, shift.id) as unknown as Array<{
      id: string
      sale_number: string
      total: number
      payment_method: string
      status: string
      completed_at: string
      cash_amount: number
      card_amount: number
      transfer_amount: number
      debt_amount: number
      is_order_sale: number
    }>
    const completed = sales.filter((sale) => sale.status === 'completed')
    const regularSales = completed.filter((sale) => sale.is_order_sale !== 1)
    const orderPayments = this.db.prepare(`
      SELECT amount, method
      FROM order_payments
      WHERE tenant_id = ? AND shift_id = ? AND deleted_at IS NULL
    `).all(tenantId, shift.id) as Array<{ amount: number; method: 'cash' | 'card' | 'transfer' | 'account' }>

    const byMethod = { cash: 0, card: 0, transfer: 0, account: 0, debt: 0 }
    for (const sale of regularSales) {
      const total = Number(sale.total ?? 0)
      byMethod.cash += Number(sale.cash_amount ?? 0) || (sale.payment_method === 'cash' ? total : 0)
      byMethod.card += Number(sale.card_amount ?? 0) || (sale.payment_method === 'card' ? total : 0)
      byMethod.transfer += Number(sale.transfer_amount ?? 0) || (sale.payment_method === 'transfer' ? total : 0)
      byMethod.debt += Number(sale.debt_amount ?? 0) || (sale.payment_method === 'debt' ? total : 0)
    }
    for (const payment of orderPayments) {
      const amount = Number(payment.amount ?? 0)
      if (payment.method === 'cash') byMethod.cash += amount
      else if (payment.method === 'card') byMethod.card += amount
      else if (payment.method === 'transfer') byMethod.transfer += amount
      else if (payment.method === 'account') byMethod.account += amount
    }

    return {
      shift,
      total_sales: completed.length,
      total_revenue: completed.reduce((sum, sale) => sum + Number(sale.total || 0), 0),
      payment_received_total: byMethod.cash + byMethod.card + byMethod.transfer + byMethod.account,
      by_method: byMethod,
      sales,
    }
  }

  reconcileShift(cashierId: string, actualAmount: number, comment: string | null, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const shift = this.getOpenShift(cashierId, tenantId)
    if (!shift) throw new Error('LOCAL_NO_SHIFT')
    const exp = this.getExpectedCash(cashierId, tenantId)
    const expected = exp?.expected_amount ?? 0
    const variance = Math.round(actualAmount) - expected
    const ts = new Date().toISOString()
    const note = comment && comment.trim()
      ? `${shift.notes ? shift.notes + '\n' : ''}Звірка: ${comment.trim()}`
      : shift.notes
    this.db.prepare(`
      UPDATE shifts
      SET expected_cash = ?, cash_variance = ?, notes = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(expected, variance, note ?? null, ts, ts, shift.id, tenantId)
    return { ok: true }
  }

  closeShift(cashierId: string, actualAmount: number, comment: string | null, tenantId = DEFAULT_TENANT_ID): { ok: true; id: string } {
    return this.db.transaction(() => {
      const shift = this.getOpenShift(cashierId, tenantId)
      if (!shift) throw new Error('LOCAL_NO_SHIFT')
      const expected = this.getExpectedCash(cashierId, tenantId)?.expected_amount ?? 0
      const closingCash = money(actualAmount)
      const variance = closingCash - expected
      const timestamp = nowIso()
      const note = comment?.trim()
        ? `${shift.notes ? shift.notes + '\n' : ''}${comment.trim()}`
        : shift.notes

      this.db.prepare(`
        UPDATE shifts
        SET status = 'closed', closing_cash = ?, expected_cash = ?, cash_variance = ?,
            closed_at = ?, notes = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(
        closingCash,
        expected,
        variance,
        timestamp,
        note ?? null,
        timestamp,
        timestamp,
        shift.id,
        tenantId,
      )

      this.addOutbox(
        tenantId,
        'shift',
        shift.id,
        'shift.closed',
        {
          id: shift.id,
          cashier_id: cashierId,
          closing_cash: closingCash,
          expected_cash: expected,
          cash_variance: variance,
          closed_at: timestamp,
          notes: note ?? null,
        },
        timestamp,
      )
      return { ok: true, id: shift.id }
    })
  }

  protected assertCashOperationAllowed(tenantId: string, shiftId: string | null, type: string, amount: number): void {
    const available = readOpenCashBalance(this.db, tenantId, shiftId)
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Некоректна сума касової операції')
    if (type !== 'cash_in' && amount > available) {
      throw new Error(`У касі недостатньо готівки. Доступно ${(available / 100).toFixed(2)} грн. Спочатку внесіть кошти або виберіть інший спосіб виплати.`)
    }
  }

  protected addCashOperation(
    tenantId: string,
    shiftId: string | null,
    userId: string | null,
    type: 'cash_in' | 'cash_out' | 'return_cash',
    amount: number,
    notes: string,
    timestamp: string,
    operationId: string = randomUUID(),
  ): void {
    this.assertCashOperationAllowed(tenantId, shiftId, type, amount)
    this.db.prepare(`
      INSERT INTO cash_operations (
        id, tenant_id, shift_id, user_id, type, source, amount, notes,
        dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'cashbox', ?, ?, ?, ?, ?)
    `).run(operationId, tenantId, shiftId, userId, type, amount, notes, timestamp, timestamp, timestamp)
  }
}
