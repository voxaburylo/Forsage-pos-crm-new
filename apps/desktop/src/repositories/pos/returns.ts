/**
 * Повернення: перевірка, створення, перелік.
 *
 * Частина каси, винесена з `posRepository.ts` (3431 рядок) — див.
 * `REFACTOR_PLAN.md`, ітерація 4. Клас поділено ланцюжком успадкування:
 * кожен шар кличе лише те, що лежить нижче, тому жоден виклик `this.` не
 * довелося переписувати. Методи перенесені рядок у рядок.
 */
import { DEFAULT_TENANT_ID } from '../../db/localTypes'
import { LocalStaffRepository } from '../staffRepository'
import type { ReturnableSaleItemRow } from './posShared'
import { allocateRefundPool, money, nowIso, operationId, payloadHash } from './posShared'
import { randomUUID } from 'node:crypto'
import { LocalPosSales } from './sales'

export class LocalPosReturns extends LocalPosSales {
  listReturns(input: { tenant_id?: string; page?: number; per_page?: number } = {}): {
    data: any[]
    pagination: { page: number; per_page: number; total: number; total_pages: number }
  } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const page = Math.max(1, Number(input.page ?? 1) || 1)
    const perPage = Math.max(1, Math.min(100, Number(input.per_page ?? 20) || 20))
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS total FROM customer_returns
      WHERE tenant_id = ? AND deleted_at IS NULL
    `).get(tenantId) as { total: number }
    const rows = this.db.prepare(`
      SELECT r.*, s.sale_number, s.total AS sale_total, c.phone AS customer_phone, c.full_name AS customer_name
      FROM customer_returns r
      JOIN sales s ON s.id = r.sale_id AND s.tenant_id = r.tenant_id
      LEFT JOIN customers c ON c.id = r.customer_id AND c.tenant_id = r.tenant_id
      WHERE r.tenant_id = ? AND r.deleted_at IS NULL
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).all(tenantId, perPage, (page - 1) * perPage) as any[]
    const total = Number(totalRow?.total ?? 0)
    return {
      data: rows.map((row) => this.decorateReturn(row, tenantId)),
      pagination: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
    }
  }

  getReturn(returnId: string, tenantId = DEFAULT_TENANT_ID): any {
    const row = this.db.prepare(`
      SELECT r.*, s.sale_number, s.total AS sale_total, c.phone AS customer_phone, c.full_name AS customer_name
      FROM customer_returns r
      JOIN sales s ON s.id = r.sale_id AND s.tenant_id = r.tenant_id
      LEFT JOIN customers c ON c.id = r.customer_id AND c.tenant_id = r.tenant_id
      WHERE r.id = ? AND r.tenant_id = ? AND r.deleted_at IS NULL
      LIMIT 1
    `).get(returnId, tenantId) as any
    if (!row) throw new Error('Повернення не знайдено')
    return this.decorateReturn(row, tenantId)
  }

  getSaleForReturn(saleId: string, tenantId = DEFAULT_TENANT_ID): any {
    const sale = this.getSale(saleId, tenantId)
    if (!['completed', 'returned'].includes(sale.status)) {
      throw new Error('Цей чек не можна повернути')
    }
    const rows = this.db.prepare(`
      SELECT si.id, si.product_id, COALESCE(p.name, si.description, '') AS product_name,
             COALESCE(si.sku, p.sku, '') AS sku, COALESCE(p.unit, 'шт') AS unit,
             si.qty, si.unit_price, COALESCE(si.discount, 0) AS discount,
             si.total, COALESCE(si.core_deposit_amount, 0) AS core_deposit_amount,
             COALESCE((
               SELECT SUM(ri.quantity)
               FROM customer_return_items ri
               JOIN customer_returns r
                 ON r.id = ri.return_id
                AND r.tenant_id = si.tenant_id
                AND r.sale_id = si.sale_id
               WHERE ri.sale_item_id = si.id
                 AND ri.tenant_id = si.tenant_id
                 AND ri.deleted_at IS NULL
                 AND r.deleted_at IS NULL
             ), 0) AS already_returned_qty,
             COALESCE((
               SELECT SUM(ri.total_kopecks)
               FROM customer_return_items ri
               JOIN customer_returns r
                 ON r.id = ri.return_id
                AND r.tenant_id = si.tenant_id
                AND r.sale_id = si.sale_id
               WHERE ri.sale_item_id = si.id
                 AND ri.tenant_id = si.tenant_id
                 AND ri.deleted_at IS NULL
                 AND r.deleted_at IS NULL
             ), 0) AS already_refunded_kopecks
      FROM sale_items si
      JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
      WHERE si.sale_id = ? AND si.tenant_id = ? AND si.deleted_at IS NULL
      ORDER BY si.created_at ASC
    `).all(saleId, tenantId) as unknown as ReturnableSaleItemRow[]
    const allocation = allocateRefundPool(Number(sale.total), rows)
    const alreadyRefunded = rows.reduce(
      (sum, item) => sum + money(Number(item.already_refunded_kopecks ?? 0)),
      0,
    )
    if (
      alreadyRefunded < 0
      || alreadyRefunded > allocation.productRefundPool
      || rows.some((item) => (
        Number(item.already_returned_qty) < 0
        || Number(item.already_returned_qty) > Number(item.qty)
        || Number(item.already_refunded_kopecks) < 0
        || Number(item.already_refunded_kopecks) > (allocation.lineRefunds.get(item.id) ?? 0)
      ))
    ) {
      throw new Error('У чеку є некоректні дані попереднього повернення')
    }
    const items = rows.map((item) => {
      const refundableTotal = allocation.lineRefunds.get(item.id) ?? 0
      const alreadyReturnedQty = Number(item.already_returned_qty)
      const alreadyRefundedKopecks = money(Number(item.already_refunded_kopecks))
      return {
        id: item.id,
        product_id: item.product_id,
        product_name: item.product_name,
        sku: item.sku,
        unit: item.unit,
        qty: Number(item.qty),
        unit_price: Number(item.unit_price),
        total: Number(item.total),
        refundable_total: refundableTotal,
        already_returned_qty: alreadyReturnedQty,
        already_refunded_kopecks: alreadyRefundedKopecks,
        available_qty: Math.max(0, Number(item.qty) - alreadyReturnedQty),
        refundable_kopecks: Math.max(0, refundableTotal - alreadyRefundedKopecks),
      }
    })
    return {
      sale: {
        id: sale.id,
        sale_number: sale.sale_number,
        status: sale.status,
        customer_id: sale.customer_id,
        total: sale.total,
        completed_at: sale.completed_at,
        is_fiscal: sale.is_fiscal,
        fiscal_number: sale.fiscal_number,
        product_refund_pool: allocation.productRefundPool,
        already_refunded_kopecks: alreadyRefunded,
        refundable_kopecks: Math.max(0, allocation.productRefundPool - alreadyRefunded),
      },
      items,
    }
  }

  createReturn(input: any): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const clientOperationId = operationId(input.client_operation_id)
    const returnHash = this.returnPayloadHash(input, tenantId)
    if (clientOperationId) {
      const existing = this.existingReturnResult(tenantId, clientOperationId, returnHash)
      if (existing) return existing
    }

    if (input.is_fiscal === true) {
      if (!clientOperationId) throw new Error('FISCAL_OPERATION_ID_REQUIRED')
      this.assertReturnReady(input)
      this.assertFiscalIntentCanReturn(clientOperationId, returnHash, input.fiscal_number)
    }

    const returnId = randomUUID()
    const timestamp = nowIso()

    return this.db.transaction(() => {
      if (clientOperationId) {
        const existing = this.existingReturnResult(tenantId, clientOperationId, returnHash)
        if (existing) return existing
      }
      if (input.is_fiscal === true && clientOperationId) {
        this.assertFiscalIntentCanReturn(clientOperationId, returnHash, input.fiscal_number)
      }
      const ready = this.assertReturnReady(input)
      const normalized = ready.normalized.map((item) => ({ ...item, id: randomUUID() }))

      this.db.prepare(`
        INSERT INTO customer_returns (
          id, tenant_id, sale_id, customer_id, return_type, reason, reason_note,
          refund_method, refund_kopecks, stock_action, status, approved_by,
          fiscal_number, client_operation_id, client_payload_hash,
          dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'customer_return', ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        returnId,
        tenantId,
        ready.sale.id,
        ready.sale.customer_id ?? null,
        String(input.reason ?? 'other'),
        input.reason_note ?? null,
        String(input.refund_method ?? 'cash'),
        ready.refund,
        String(input.stock_action ?? 'return_to_stock'),
        ready.approved_by,
        input.fiscal_number ?? null,
        clientOperationId,
        clientOperationId ? returnHash : null,
        timestamp,
        timestamp,
        timestamp,
      )

      for (const item of normalized) {
        this.db.prepare(`
          INSERT INTO customer_return_items (
            id, tenant_id, return_id, sale_item_id, product_id, quantity,
            unit_price_kopecks, total_kopecks, condition, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id,
          tenantId,
          returnId,
          item.sale_item_id,
          item.product_id,
          item.quantity,
          item.unit_price,
          item.total,
          item.condition,
          timestamp,
          timestamp,
        )
        if (input.stock_action === 'return_to_stock' && item.product_id) {
          const product = this.getProductForUpdate(item.product_id, tenantId)
          if (product) {
            const nextQty = Number(product.qty_on_hand ?? 0) + item.quantity
            this.db.prepare(`
              UPDATE products SET qty_on_hand = ?, dirty_at = ?, updated_at = ?
              WHERE id = ? AND tenant_id = ?
            `).run(nextQty, timestamp, timestamp, item.product_id, tenantId)
            this.db.prepare(`
              INSERT INTO inventory_movements (
                id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
                unit_cost, notes, dirty_at, created_at, updated_at
              ) VALUES (?, ?, ?, 'customer_return', ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              randomUUID(),
              tenantId,
              item.product_id,
              returnId,
              item.quantity,
              nextQty,
              item.unit_price,
              `Повернення за чеком ${ready.sale.sale_number}`,
              timestamp,
              timestamp,
              timestamp,
            )
          }
        }
      }

      // Якщо чек створено під час видачі замовлення, відразу показуємо у його
      // картці лише ті позиції, які вже повернуті повністю.
      this.db.prepare(`
        UPDATE customer_order_items
        SET item_status = 'returned', dirty_at = ?, updated_at = ?
        WHERE tenant_id = ?
          AND deleted_at IS NULL
          AND order_id = (
            SELECT id FROM customer_orders
            WHERE sale_id = ? AND tenant_id = ? AND deleted_at IS NULL
            LIMIT 1
          )
          AND product_id IN (
            SELECT si.product_id
            FROM sale_items si
            LEFT JOIN (
              SELECT sale_item_id, SUM(quantity) AS qty
              FROM customer_return_items
              WHERE tenant_id = ?
              GROUP BY sale_item_id
            ) returned ON returned.sale_item_id = si.id
            WHERE si.sale_id = ? AND si.tenant_id = ? AND si.deleted_at IS NULL
            GROUP BY si.product_id
            HAVING COALESCE(SUM(returned.qty), 0) >= SUM(si.qty)
          )
      `).run(
        timestamp, timestamp, tenantId, ready.sale.id, tenantId,
        tenantId, ready.sale.id, tenantId,
      )

      if (input.refund_method === 'cash') {
        this.addCashOperation(
          tenantId,
          ready.shift_id,
          ready.approved_by,
          'return_cash',
          ready.refund,
          `Повернення за чеком ${ready.sale.sale_number}`,
          timestamp,
          returnId,
        )
      } else if (ready.sale.customer_id && input.refund_method === 'debt_reduction') {
        const updated = this.db.prepare(`
          UPDATE customers
          SET debt_balance = debt_balance - ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
            AND COALESCE(debt_balance, 0) >= ?
        `).run(
          ready.refund,
          timestamp,
          timestamp,
          ready.sale.customer_id,
          tenantId,
          ready.refund,
        ) as { changes: number | bigint }
        if (Number(updated.changes) !== 1) {
          throw new Error('Сума боргу клієнта менша за суму повернення')
        }
      } else if (ready.sale.customer_id && input.refund_method === 'credit') {
        const customer = this.getCustomerForMoney(ready.sale.customer_id, tenantId)
        const balanceAfter = Number(customer.deposit_balance ?? 0) + ready.refund
        const updated = this.db.prepare(`
          UPDATE customers SET deposit_balance = ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).run(balanceAfter, timestamp, timestamp, ready.sale.customer_id, tenantId) as {
          changes: number | bigint
        }
        if (Number(updated.changes) !== 1) {
          throw new Error('Клієнта не знайдено')
        }
        this.db.prepare(`
          INSERT INTO customer_deposit_transactions (
            id, tenant_id, customer_id, amount, balance_after, method, sale_id,
            shift_id, notes, created_by, dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'return_credit', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          tenantId,
          ready.sale.customer_id,
          ready.refund,
          balanceAfter,
          ready.sale.id,
          ready.shift_id,
          `Повернення за чеком ${ready.sale.sale_number}`,
          ready.approved_by,
          timestamp,
          timestamp,
          timestamp,
        )
      }

      const remaining = this.getSaleForReturn(ready.sale.id, tenantId).items
        .reduce((sum: number, item: any) => sum + Number(item.available_qty ?? 0), 0)
      if (remaining <= 0) {
        this.db.prepare(`
          UPDATE sales SET status = 'returned', dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(timestamp, timestamp, ready.sale.id, tenantId)
      }

      this.addOutbox(tenantId, 'customer_return', returnId, 'return.created', {
        id: returnId,
        client_operation_id: clientOperationId,
        sale_id: ready.sale.id,
        reason: input.reason,
        reason_note: input.reason_note ?? null,
        refund_method: input.refund_method,
        stock_action: input.stock_action,
        fiscal_number: input.fiscal_number ?? null,
        refund_kopecks: ready.refund,
        shift_id: ready.shift_id,
        items: normalized,
      }, timestamp)
      this.addAudit(tenantId, ready.approved_by, 'return.created', 'customer_return', returnId, {
        sale_id: ready.sale.id,
        refund_kopecks: ready.refund,
      }, timestamp)

      new LocalStaffRepository(this.db).recordReturnCommissionReversals(
        returnId, ready.sale.id, normalized, tenantId, ready.approved_by,
      )

      const result = this.getReturn(returnId, tenantId)
      if (input.is_fiscal === true && clientOperationId) {
        const completed = this.db.prepare(`
          UPDATE fiscal_sale_intents
          SET state = 'completed', return_id = ?, checkout_result_json = ?,
              completed_at = ?, updated_at = ?
          WHERE operation_id = ? AND tenant_id = ?
            AND operation_kind = 'return' AND state = 'fiscalized'
        `).run(
          returnId,
          JSON.stringify(result),
          timestamp,
          timestamp,
          clientOperationId,
          tenantId,
        ) as { changes: number | bigint }
        if (Number(completed.changes) !== 1) throw new Error('FISCAL_INTENT_NOT_READY')
      }
      return result
    })
  }

  protected assertReturnReady(input: any): {
    tenant_id: string
    sale: any
    normalized: Array<{
      sale_item_id: string
      product_id: string
      quantity: number
      unit_price: number
      total: number
      condition: string
    }>
    refund: number
    approved_by: string
    shift_id: string | null
  } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const sale = this.getSale(input.sale_id, tenantId)
    const available = this.getSaleForReturn(input.sale_id, tenantId)
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new Error('Оберіть товар для повернення')
    }
    if (sale.status === 'returned' && !available.items.some((item: any) => item.available_qty > 0)) {
      throw new Error('Чек уже повністю повернуто')
    }
    const refundMethod = String(input.refund_method ?? 'cash')
    if (!['cash', 'terminal', 'debt_reduction', 'credit'].includes(refundMethod)) {
      throw new Error('Некоректний спосіб повернення')
    }
    if ((refundMethod === 'credit' || refundMethod === 'debt_reduction') && !sale.customer_id) {
      throw new Error('Цей спосіб повернення можливий лише для чека з клієнтом')
    }
    const stockAction = String(input.stock_action ?? 'return_to_stock')
    if (!['return_to_stock', 'write_off', 'send_to_supplier'].includes(stockAction)) {
      throw new Error('Некоректна дія з поверненим товаром')
    }
    const availableById = new Map(available.items.map((item: any) => [item.id, item]))
    const seen = new Set<string>()
    const normalized = input.items.map((item: any) => {
      const saleItemId = String(item.sale_item_id ?? '').trim()
      if (!saleItemId || seen.has(saleItemId)) {
        throw new Error('Одна позиція чека не може бути вказана двічі')
      }
      seen.add(saleItemId)
      const source = availableById.get(saleItemId) as any
      const productId = String(item.product_id ?? '').trim()
      const quantity = Number(item.quantity ?? 0)
      if (!source) {
        throw new Error('Позицію чека не знайдено')
      }
      if (!productId || source.product_id !== productId) {
        throw new Error('Товар не відповідає позиції чека')
      }
      if (
        !Number.isFinite(quantity)
        || quantity <= 0
        || quantity > Number(source.available_qty) + Number.EPSILON
      ) {
        throw new Error(`Для ${source.product_name} доступно до повернення: ${source.available_qty}`)
      }
      const condition = String(item.condition ?? 'good')
      if (
        !['good', 'damaged', 'opened_packaging', 'defective'].includes(condition)
        || (condition === 'defective' && stockAction === 'return_to_stock')
      ) {
        throw new Error('Стан товару не відповідає вибраній дії')
      }
      const remainingRefund = Math.max(
        0,
        Number(source.refundable_total) - Number(source.already_refunded_kopecks),
      )
      const isFinalQuantity = quantity >= Number(source.available_qty) - Number.EPSILON
      const total = isFinalQuantity
        ? remainingRefund
        : Math.min(
            remainingRefund,
            money(Number(source.refundable_total) * quantity / Number(source.qty)),
          )
      return {
        sale_item_id: source.id,
        product_id: source.product_id,
        quantity,
        unit_price: Number(source.unit_price),
        total,
        condition,
      }
    })
    const refund = normalized.reduce((sum: number, item: any) => sum + item.total, 0)
    const approvedBy = input.approved_by ?? sale.cashier_id ?? 'local'
    const shiftId = input.shift_id ?? this.findOpenShift(approvedBy, tenantId) ?? null
    if (refundMethod === 'credit' || refundMethod === 'debt_reduction') {
      const customer = this.getCustomerForMoney(sale.customer_id, tenantId)
      if (refundMethod === 'debt_reduction' && Number(customer.debt_balance ?? 0) < refund) {
        throw new Error('Сума боргу клієнта менша за суму повернення')
      }
    }
    if (refundMethod === 'cash') {
      if (!shiftId) throw new Error('Для повернення готівки потрібна відкрита касова зміна')
      const openShift = this.db.prepare(`
        SELECT id FROM shifts
        WHERE id = ? AND tenant_id = ? AND cashier_id = ?
          AND status = 'open' AND deleted_at IS NULL
        LIMIT 1
      `).get(shiftId, tenantId, approvedBy)
      if (!openShift) throw new Error('Касова зміна для повернення вже закрита')
      const expectedCash = this.getExpectedCash(approvedBy, tenantId)?.expected_amount ?? 0
      if (expectedCash < refund) {
        throw new Error(`У касі недостатньо готівки. Доступно ${(expectedCash / 100).toFixed(2)} грн, потрібно ${(refund / 100).toFixed(2)} грн`)
      }
    }
    return {
      tenant_id: tenantId,
      sale,
      normalized,
      refund,
      approved_by: approvedBy,
      shift_id: shiftId,
    }
  }

  protected returnIdentity(input: any, tenantId: string): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      sale_id: String(input.sale_id ?? ''),
      approved_by: input.approved_by ?? null,
      shift_id: input.shift_id ?? null,
      reason: String(input.reason ?? 'other'),
      reason_note: input.reason_note ?? null,
      refund_method: String(input.refund_method ?? 'cash'),
      stock_action: String(input.stock_action ?? 'return_to_stock'),
      is_fiscal: input.is_fiscal === true,
      items: Array.isArray(input.items)
        ? input.items.map((item: any) => ({
            sale_item_id: item.sale_item_id ?? null,
            product_id: item.product_id ?? null,
            quantity: Number(item.quantity),
            condition: String(item.condition ?? 'good'),
          }))
        : [],
    }
  }

  protected returnPayloadHash(input: any, tenantId: string): string {
    return payloadHash(this.returnIdentity(input, tenantId))
  }

  protected existingReturnResult(tenantId: string, id: string, expectedHash: string): any | null {
    const row = this.db.prepare(`
      SELECT id, client_payload_hash
      FROM customer_returns
      WHERE tenant_id = ? AND client_operation_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(tenantId, id) as { id: string; client_payload_hash: string | null } | undefined
    if (!row) return null
    if (row.client_payload_hash !== expectedHash) {
      throw new Error('LOCAL_RETURN_OPERATION_CONFLICT|Цей номер операції вже використано для іншого повернення')
    }
    return this.getReturn(row.id, tenantId)
  }
}
