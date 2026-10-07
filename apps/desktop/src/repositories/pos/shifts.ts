/**
 * Зміни й готівка: відкриття, звірка, закриття, касові операції.
 *
 * Частина каси, винесена з `posRepository.ts` (3431 рядок) — див.
 * `REFACTOR_PLAN.md`, ітерація 4. Клас поділено ланцюжком успадкування:
 * кожен шар кличе лише те, що лежить нижче, тому жоден виклик `this.` не
 * довелося переписувати. Методи перенесені рядок у рядок.
 */
import { DEFAULT_TENANT_ID } from '../../db/localTypes'
import { nowIso } from './posShared'
import { randomUUID } from 'node:crypto'
import { LocalPosFiscalGuards } from './fiscalGuards'
import { cashAmount, cashSum, readOpenCashBalance, readOpenCashBreakdown, type CashBreakdown } from '../cashBalance'
import { idempotentMutation } from '../idempotentMutation'
import { readShiftRefunds, type ShiftMoneyByMethod } from './shiftRefunds'

function validateCashAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Некоректна сума готівки')
}

export class LocalPosShifts extends LocalPosFiscalGuards {
  openShift(input: {
    tenant_id?: string
    cashier_id: string
    opening_cash?: number
    notes?: string | null
  }): string {
    validateCashAmount(input.opening_cash ?? 0)
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
    operation_id?: string
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
    validateCashAmount(input.amount)
    const amount = input.amount
    if (amount <= 0) throw new Error('Вкажіть суму більше нуля')
    if (!['in', 'out'].includes(input.type)) throw new Error('Некоректний тип касової операції')
    const id = input.operation_id ?? randomUUID()
    const previous = this.db.prepare('SELECT * FROM cash_operations WHERE id = ?').get(id) as any
    if (previous) {
      if (previous.tenant_id !== tenantId || previous.shift_id !== input.shift_id || previous.amount !== amount
        || previous.type !== (input.type === 'in' ? 'cash_in' : 'cash_out')
        || previous.user_id !== (input.user_id ?? null) || previous.notes !== (input.note ?? null)
        || previous.source !== (input.source ?? 'cashbox')) throw new Error('Повтор касової операції містить інші дані')
      return { id, shift_id: input.shift_id, type: input.type, amount, note: previous.notes,
        created_by: previous.user_id ?? 'local', created_at: previous.created_at }
    }
    const shift = this.db.prepare(`
      SELECT id, cashier_id FROM shifts
      WHERE id = ? AND tenant_id = ? AND status = 'open' AND deleted_at IS NULL
    `).get(input.shift_id, tenantId) as { id: string; cashier_id: string } | undefined
    if (!shift) throw new Error('Касову зміну не знайдено або вже закрито')
    if (input.user_id && input.user_id !== shift.cashier_id) throw new Error('Касова зміна належить іншому касиру')
    const timestamp = nowIso()
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
      WHERE shift_id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).get(shiftId, tenantId) as { total_in: number; total_out: number }
    const totalIn = Number(row?.total_in ?? 0)
    const totalOut = Number(row?.total_out ?? 0)
    return { total_in: totalIn, total_out: totalOut, net: totalIn - totalOut }
  }

  getExpectedCash(cashierId: string, tenantId = DEFAULT_TENANT_ID): CashBreakdown | null {
    return this.db.readSnapshot(() => {
      const shift = this.getOpenShift(cashierId, tenantId)
      return shift ? readOpenCashBreakdown(this.db, tenantId, shift.id) : null
    })
  }

  getShiftReport(cashierId: string, tenantId = DEFAULT_TENANT_ID): {
    shift: NonNullable<ReturnType<LocalPosShifts['getOpenShift']>>
    total_sales: number
    gross_revenue: number
    cash_breakdown: CashBreakdown
    refund_total: number
    total_revenue: number
    payment_received_total: number
    payment_refunded_total: number
    payment_net_total: number
    unassigned_refunds_count: number
    by_method: ShiftMoneyByMethod
    refunds_by_method: ShiftMoneyByMethod
    sales: Array<{
      id: string
      sale_number: string
      total: number
      payment_method: string
      status: string
      completed_at: string
    }>
  } | null {
    return this.db.readSnapshot(() => {
      const shift = this.getOpenShift(cashierId, tenantId)
      if (!shift) return null
      const sales = this.db.prepare(`
        SELECT s.id, s.sale_number, s.total, s.payment_method, s.status, s.completed_at,
               s.cash_amount, s.card_amount, s.transfer_amount, s.debt_amount,
               EXISTS (
                 SELECT 1 FROM customer_orders o
                 WHERE o.tenant_id = s.tenant_id AND o.sale_id = s.id
               ) AS is_order_sale
        FROM sales s
        WHERE s.tenant_id = ? AND s.shift_id = ? AND s.deleted_at IS NULL
        ORDER BY s.completed_at ASC
      `).all(tenantId, shift.id) as Array<{
        id: string; sale_number: string; total: number; payment_method: string; status: string
        completed_at: string; cash_amount: number; card_amount: number; transfer_amount: number
        debt_amount: number; is_order_sale: number
      }>
      // A returned receipt remains a sale. Its refunds belong to the refund's shift.
      const settled = sales.filter(sale => sale.status === 'completed' || sale.status === 'returned')
      const payments = this.db.prepare(`
        SELECT p.sale_id, p.method, p.amount
        FROM sale_payments p JOIN sales s ON s.id = p.sale_id AND s.tenant_id = p.tenant_id
        WHERE s.tenant_id = ? AND s.shift_id = ? AND s.deleted_at IS NULL AND p.deleted_at IS NULL
      `).all(tenantId, shift.id) as Array<{ sale_id: string; method: string; amount: number }>
      const paymentsBySale = new Map<string, typeof payments>()
      for (const payment of payments) {
        const group = paymentsBySale.get(payment.sale_id) ?? []
        group.push(payment)
        paymentsBySale.set(payment.sale_id, group)
      }
      const orderPayments = this.db.prepare(`
        SELECT amount, method FROM order_payments
        WHERE tenant_id = ? AND shift_id = ? AND deleted_at IS NULL
      `).all(tenantId, shift.id) as Array<{ amount: number; method: string }>

      const byMethod: ShiftMoneyByMethod = { cash: 0, card: 0, transfer: 0, account: 0, debt: 0 }
      const addPayment = (method: string, amount: number) => {
        if (!Object.hasOwn(byMethod, method)) throw new Error('Невідомий спосіб оплати у звіті зміни')
        const key = method as keyof ShiftMoneyByMethod
        byMethod[key] = cashSum(byMethod[key], cashAmount(amount))
      }
      // Order payments are counted at receipt time, including prepayments. Archiving
      // the order must not turn its completed sale into a second payment.
      for (const sale of settled.filter(sale => sale.is_order_sale !== 1)) {
        const actualPayments = paymentsBySale.get(sale.id)
        if (actualPayments?.length) {
          for (const payment of actualPayments) addPayment(payment.method, payment.amount)
          continue
        }
        // Legacy receipts have summary columns but no payment rows. Fall back once,
        // never replace an individual zero column with the whole mixed receipt.
        const legacy: ShiftMoneyByMethod = {
          cash: Number(sale.cash_amount ?? 0), card: Number(sale.card_amount ?? 0),
          transfer: Number(sale.transfer_amount ?? 0), debt: Number(sale.debt_amount ?? 0), account: 0,
        }
        if (Object.values(legacy).some(amount => amount !== 0)) {
          for (const [method, amount] of Object.entries(legacy)) addPayment(method, amount)
        } else {
          addPayment(sale.payment_method, Number(sale.total ?? 0))
        }
      }
      for (const payment of orderPayments) addPayment(payment.method, payment.amount)

      const refunds = readShiftRefunds(this.db, tenantId, shift)
      const grossRevenue = settled.reduce((sum, sale) => cashSum(sum, cashAmount(sale.total)), 0)
      const received = cashSum(byMethod.cash, byMethod.card, byMethod.transfer, byMethod.account)
      return {
        shift,
        total_sales: settled.length,
        gross_revenue: grossRevenue,
        cash_breakdown: readOpenCashBreakdown(this.db, tenantId, shift.id),
        refund_total: refunds.total,
        total_revenue: cashSum(grossRevenue, -refunds.total),
        payment_received_total: received,
        payment_refunded_total: refunds.paymentRefunded,
        payment_net_total: cashSum(received, -refunds.paymentRefunded),
        unassigned_refunds_count: refunds.unassignedCount,
        by_method: byMethod,
        refunds_by_method: refunds.byMethod,
        sales,
      }
    })
  }

  reconcileShift(cashierId: string, actualAmount: number, comment: string | null, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    validateCashAmount(actualAmount)
    return this.db.transaction(() => {
      const shift = this.getOpenShift(cashierId, tenantId)
      if (!shift) throw new Error('LOCAL_NO_SHIFT')
      const expected = readOpenCashBreakdown(this.db, tenantId, shift.id).expected_amount
      const variance = cashSum(actualAmount, -expected)
      const ts = nowIso()
      const note = comment?.trim()
        ? `${shift.notes ? shift.notes + '\n' : ''}Звірка: ${comment.trim()}`
        : shift.notes
      this.db.prepare(`
        UPDATE shifts
        SET expected_cash = ?, cash_variance = ?, notes = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'open' AND deleted_at IS NULL
      `).run(expected, variance, note ?? null, ts, ts, shift.id, tenantId)
      return { ok: true as const }
    })
  }

  closeShift(cashierId: string, actualAmount: number, comment: string | null, shiftId: string, tenantId = DEFAULT_TENANT_ID, role = 'cashier'): { ok: true; id: string } {
    validateCashAmount(actualAmount)
    if (!shiftId?.trim()) throw new Error('Не вказано зміну для закриття')
    return idempotentMutation(this.db, `shift-close:${tenantId}`, shiftId, { cashierId, actualAmount, comment: comment?.trim() || null }, () => {
      const shift = this.getOpenShift(cashierId, tenantId)
      if (!shift || shift.id !== shiftId) throw new Error('Ця зміна вже закрита або не належить касиру. Оновіть дані зміни.')
      const expected = readOpenCashBreakdown(this.db, tenantId, shift.id).expected_amount
      const closingCash = actualAmount
      const variance = cashSum(closingCash, -expected)
      const canOverride = role === 'owner' || role === 'admin'
      if (!canOverride && variance !== 0) throw new Error(`Сума не сходиться. Очікується ${(expected / 100).toFixed(2)} грн. Оновіть дані зміни.`)
      if (canOverride && Math.abs(variance) > 1000 && !comment?.trim()) throw new Error('Розбіжність > 10 грн — поясніть у коментарі')
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
      this.db.prepare(`
        INSERT OR IGNORE INTO shift_backups (id, tenant_id, device_id, closed_at, created_at)
        VALUES (?, ?, (SELECT json_extract(value_json, '$') FROM app_meta WHERE key = 'device_id'), ?, ?)
      `).run(shift.id, tenantId, timestamp, timestamp)
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
