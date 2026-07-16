import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import {
  DEFAULT_TENANT_ID,
  type LocalProduct,
  type LocalSaleCheckoutInput,
  type LocalSaleCheckoutResult,
  type LocalSalePaymentInput,
} from '../db/localTypes'

function nowIso(): string {
  return new Date().toISOString()
}

function dayStamp(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

function money(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value)
}

function lineTotal(qty: number, unitPrice: number, discount = 0): number {
  return Math.max(0, money(qty * unitPrice) - money(discount))
}

function paymentMethod(payments: LocalSalePaymentInput[]): LocalSaleCheckoutResult['payment_method'] {
  const methods = Array.from(new Set(payments.map((payment) => payment.method)))
  return methods.length === 1 ? methods[0] : 'mixed'
}

export class LocalPosRepository {
  constructor(private readonly db: LocalDatabase) {}

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

  // Список боржників з локальної бази (клієнти з боргом > 0), для каси офлайн.
  listDebtors(tenantId = DEFAULT_TENANT_ID, limit = 200): Array<{
    id: string
    full_name: string | null
    phone: string | null
    debt_balance: number
  }> {
    return this.db.prepare(`
      SELECT id, full_name, phone, debt_balance
      FROM customers
      WHERE tenant_id = ? AND deleted_at IS NULL AND debt_balance > 0
      ORDER BY debt_balance DESC
      LIMIT ?
    `).all(tenantId, limit) as unknown as Array<{
      id: string; full_name: string | null; phone: string | null; debt_balance: number
    }>
  }

  // Очікувана готівка у відкритій зміні (звірка каси) — з локальних даних.
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
      WHERE tenant_id = ? AND shift_id = ?
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
      expected_amount: Math.max(0, expected),
    }
  }

  getShiftReport(cashierId: string, tenantId = DEFAULT_TENANT_ID): {
    shift: NonNullable<ReturnType<LocalPosRepository['getOpenShift']>>
    total_sales: number
    total_revenue: number
    by_method: { cash: number; card: number; debt: number }
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
      SELECT id, sale_number, total, payment_method, status, completed_at,
             cash_amount, card_amount
      FROM sales
      WHERE tenant_id = ? AND shift_id = ? AND deleted_at IS NULL
      ORDER BY completed_at ASC
    `).all(tenantId, shift.id) as unknown as Array<{
      id: string
      sale_number: string
      total: number
      payment_method: string
      status: string
      completed_at: string
      cash_amount: number
      card_amount: number
    }>
    const completed = sales.filter((sale) => sale.status === 'completed')
    return {
      shift,
      total_sales: completed.length,
      total_revenue: completed.reduce((sum, sale) => sum + Number(sale.total || 0), 0),
      by_method: {
        cash: completed.reduce((sum, sale) => sum + Number(sale.cash_amount || 0), 0),
        card: completed.reduce((sum, sale) => sum + Number(sale.card_amount || 0), 0),
        debt: completed
          .filter((sale) => sale.payment_method === 'debt')
          .reduce((sum, sale) => sum + Number(sale.total || 0), 0),
      },
      sales,
    }
  }

  // Зберегти звірку каси локально (оновлюємо зміну очікуваною сумою й розбіжністю).
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

  checkout(input: LocalSaleCheckoutInput): LocalSaleCheckoutResult {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    if (input.items.length === 0) throw new Error('LOCAL_SALE_EMPTY')
    if (input.payments.length === 0) throw new Error('LOCAL_SALE_PAYMENT_REQUIRED')

    return this.db.transaction(() => {
      const timestamp = nowIso()
      const saleId = randomUUID()
      const shiftId = input.shift_id ?? this.findOpenShift(input.cashier_id, tenantId)
      if (!shiftId) throw new Error('LOCAL_OPEN_SHIFT_REQUIRED')

      const saleNumber = this.nextSaleNumber(tenantId, timestamp)
      const payments = this.summarizePayments(input.payments)
      let subtotal = 0
      const preparedItems = input.items.map((item) => {
        if (item.qty <= 0) throw new Error('LOCAL_SALE_INVALID_QTY')
        const product = item.product_id
          ? this.getProductForUpdate(item.product_id, tenantId)
          : null
        if (item.product_id && !product) throw new Error('LOCAL_PRODUCT_NOT_FOUND')

        const unitPrice = money(item.unit_price ?? product?.retail_price ?? 0)
        if (unitPrice <= 0) throw new Error('LOCAL_SALE_INVALID_PRICE')

        const total = lineTotal(item.qty, unitPrice, item.discount ?? 0)
        subtotal += total

        return {
          id: randomUUID(),
          product,
          product_id: product?.id ?? null,
          description: item.description ?? product?.name ?? 'Вільна сума',
          sku: product?.sku ?? null,
          qty: item.qty,
          unit_price: unitPrice,
          purchase_price: product?.purchase_price ?? 0,
          discount: money(item.discount ?? 0),
          total,
        }
      })

      const discount = money(input.discount ?? 0)
      const total = Math.max(0, subtotal - discount)
      const paidTotal = payments.cash + payments.card + payments.transfer + payments.debt
      if (paidTotal !== total) throw new Error('LOCAL_SALE_PAYMENT_MISMATCH')

      const method = paymentMethod(input.payments)
      this.db.prepare(`
        INSERT INTO sales (
          id, tenant_id, sale_number, customer_id, cashier_id, manager_id, shift_id,
          status, subtotal, discount, total, payment_method, is_debt, is_fiscal,
          fiscal_number, fiscal_qr_url,
          cash_amount, card_amount, transfer_amount, debt_amount, notes,
          completed_at, dirty_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        saleId,
        tenantId,
        saleNumber,
        input.customer_id ?? null,
        input.cashier_id,
        input.manager_id ?? null,
        shiftId,
        subtotal,
        discount,
        total,
        method,
        payments.debt > 0 ? 1 : 0,
        input.is_fiscal === true ? 1 : 0,
        input.fiscal_number ?? null,
        input.fiscal_qr_url ?? null,
        payments.cash,
        payments.card,
        payments.transfer,
        payments.debt,
        input.notes ?? null,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )

      for (const item of preparedItems) {
        this.db.prepare(`
          INSERT INTO sale_items (
            id, tenant_id, sale_id, product_id, description, sku, qty, unit_price,
            purchase_price, discount, total, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id,
          tenantId,
          saleId,
          item.product_id,
          item.description,
          item.sku,
          item.qty,
          item.unit_price,
          item.purchase_price,
          item.discount,
          item.total,
          timestamp,
          timestamp,
        )

        if (item.product && item.product.is_service !== 1) {
          const qtyAfter = Number(item.product.qty_on_hand) - Number(item.qty)
          this.db.prepare(`
            UPDATE products
            SET qty_on_hand = ?, dirty_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?
          `).run(qtyAfter, timestamp, timestamp, item.product.id, tenantId)

          this.db.prepare(`
            INSERT INTO inventory_movements (
              id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
              unit_cost, notes, dirty_at, created_at, updated_at
            )
            VALUES (?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            tenantId,
            item.product.id,
            saleId,
            -Number(item.qty),
            qtyAfter,
            item.purchase_price,
            `Sale ${saleNumber}`,
            timestamp,
            timestamp,
            timestamp,
          )
        }
      }

      for (const payment of input.payments) {
        this.db.prepare(`
          INSERT INTO sale_payments (
            id, tenant_id, sale_id, method, amount, is_fiscal, fiscal_number,
            bank_auth_code, terminal_rrn, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          tenantId,
          saleId,
          payment.method,
          payment.amount,
          payment.is_fiscal === true ? 1 : 0,
          payment.fiscal_number ?? null,
          payment.bank_auth_code ?? null,
          payment.terminal_rrn ?? null,
          timestamp,
          timestamp,
        )
      }

      if (payments.cash > 0) {
        this.db.prepare(`
          INSERT INTO cash_operations (
            id, tenant_id, shift_id, user_id, type, source, amount, sale_id,
            notes, dirty_at, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, 'sale_cash', 'cashbox', ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          tenantId,
          shiftId,
          input.cashier_id,
          payments.cash,
          saleId,
          `Cash payment ${saleNumber}`,
          timestamp,
          timestamp,
          timestamp,
        )
      }

      const outboxSequence = this.addOutbox(
        tenantId,
        'sale',
        saleId,
        'sale.completed',
        {
          sale_id: saleId,
          sale_number: saleNumber,
          shift_id: shiftId,
          customer_id: input.customer_id ?? null,
          cashier_id: input.cashier_id,
          manager_id: input.manager_id ?? null,
          subtotal,
          discount,
          total,
          payment_method: method,
          payments: input.payments,
          items: preparedItems.map((item) => ({
            product_id: item.product_id,
            description: item.description,
            sku: item.sku,
            qty: item.qty,
            unit_price: item.unit_price,
            purchase_price: item.purchase_price,
            discount: item.discount,
            total: item.total,
          })),
          completed_at: timestamp,
        },
        timestamp,
      )

      this.addAudit(
        tenantId,
        input.cashier_id,
        'sale.completed',
        'sale',
        saleId,
        { sale_number: saleNumber, total, payment_method: method },
        timestamp,
      )

      return {
        sale_id: saleId,
        sale_number: saleNumber,
        total,
        subtotal,
        payment_method: method,
        outbox_sequence: outboxSequence,
      }
    })
  }

  private nextSaleNumber(tenantId: string, timestamp: string): string {
    const scope = `${tenantId}:sale:${dayStamp(new Date(timestamp))}`
    const row = this.db.prepare(`
      INSERT INTO local_sequences(scope, value, updated_at)
      VALUES (?, 1, ?)
      ON CONFLICT(scope) DO UPDATE SET
        value = value + 1,
        updated_at = excluded.updated_at
      RETURNING value
    `).get(scope, timestamp) as { value: number } | undefined

    const sequence = row?.value ?? 1
    return `L-${dayStamp(new Date(timestamp))}-${String(sequence).padStart(6, '0')}`
  }

  private getProductForUpdate(productId: string, tenantId: string): LocalProduct | null {
    const row = this.db.prepare(`
      SELECT id, tenant_id, sku, name, barcode, unit, purchase_price, retail_price,
             qty_on_hand, is_active, is_service, storage_bin
      FROM products
      WHERE id = ?
        AND tenant_id = ?
        AND deleted_at IS NULL
        AND is_active = 1
    `).get(productId, tenantId) as LocalProduct | undefined
    return row ?? null
  }

  private summarizePayments(payments: LocalSalePaymentInput[]): {
    cash: number
    card: number
    transfer: number
    debt: number
  } {
    return payments.reduce((acc, payment) => {
      acc[payment.method] += money(payment.amount)
      return acc
    }, { cash: 0, card: 0, transfer: 0, debt: 0 })
  }

  private addOutbox(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    operationType: string,
    payload: unknown,
    timestamp: string,
  ): number | bigint {
    const result = this.db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      randomUUID(),
      tenantId,
      this.db.deviceId,
      aggregateType,
      aggregateId,
      operationType,
      JSON.stringify(payload),
      timestamp,
    ) as { lastInsertRowid: number | bigint }
    return result.lastInsertRowid
  }

  private addAudit(
    tenantId: string,
    userId: string,
    action: string,
    entityType: string,
    entityId: string,
    after: unknown,
    timestamp: string,
  ): void {
    this.db.prepare(`
      INSERT INTO audit_log (
        event_id, tenant_id, device_id, user_id, action, entity_type, entity_id,
        after_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      tenantId,
      this.db.deviceId,
      userId,
      action,
      entityType,
      entityId,
      JSON.stringify(after),
      timestamp,
    )
  }
}
