/**
 * Винесено з `syncService.ts` без зміни поведінки — див. `REFACTOR_PLAN.md`,
 * ітерація 4. У файлі на 4900 рядків помилку не видно очима.
 */

import { runTransaction } from '../../db/pg.js'
import { db } from '../../db/supabase.js'
import { AppError } from '../../middleware/errorHandler.js'
import { isUuid, uuidOr } from './syncCore.js'
import type { SyncOutboxOperation } from './syncCore.js'
import { ensureFreeAmountProduct } from './syncGuards.js'
import { normalizePaymentMethod, sumPayments } from './syncMath.js'
import { randomUUID } from 'node:crypto'

export async function applyCashOperationCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const id = String(payload.id ?? operation.aggregate_id)
  const amount = Math.round(Number(payload.amount ?? 0))
  if (!isUuid(id) || amount <= 0) throw new AppError('SYNC_CASH_OPERATION_INVALID', 'Некоректна касова операція', 400)
  const type = payload.type === 'out' || payload.type === 'cash_out' || payload.type === 'salary_payout' || payload.type === 'supplier_payment'
    ? 'out'
    : 'in'
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `INSERT INTO cash_operations (
        id, tenant_id, shift_id, type, amount, note, source, created_by, employee_id, work_date, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (id) DO NOTHING`,
      [
        id,
        tenantId,
        isUuid(payload.shift_id) ? payload.shift_id : null,
        type,
        amount,
        payload.note ?? payload.notes ?? null,
        payload.source ?? 'cashbox',
        uuidOr(payload.user_id ?? payload.created_by, userId),
        isUuid(payload.employee_id) ? payload.employee_id : null,
        /^\d{4}-\d{2}-\d{2}$/.test(String(payload.work_date ?? '')) ? payload.work_date : null,
        createdAt,
        appliedAt,
      ],
    )
  })
}

export async function applyReturnCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const returnId = String(payload.id ?? operation.aggregate_id)
  const saleId = String(payload.sale_id ?? '')
  const items = Array.isArray(payload.items) ? payload.items : []
  if (!isUuid(returnId) || !isUuid(saleId) || items.length === 0) {
    throw new AppError('SYNC_RETURN_INVALID', 'Некоректне повернення товару', 400)
  }

  const allowedReasons = new Set(['defective', 'wrong_part', 'changed_mind', 'customer_changed_mind', 'warranty', 'duplicate', 'other'])
  const allowedConditions = new Set(['good', 'defective', 'damaged', 'opened_packaging'])
  const allowedStockActions = new Set(['return_to_stock', 'write_off', 'send_to_supplier'])
  const reason = allowedReasons.has(String(payload.reason)) ? String(payload.reason) : 'other'
  const stockAction = allowedStockActions.has(String(payload.stock_action)) ? String(payload.stock_action) : 'return_to_stock'
  const requestedRefundMethod = payload.refund_method === 'card' ? 'terminal' : String(payload.refund_method ?? 'cash')
  const refundMethod = ['cash', 'terminal', 'debt_reduction', 'credit'].includes(requestedRefundMethod)
    ? requestedRefundMethod
    : 'cash'
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  let returnShiftId = isUuid(payload.shift_id) ? payload.shift_id : null

  await runTransaction(async (client) => {
    await client.query("SELECT set_config('app.sync_mode', 'true', true)")
    const existing = await client.query(
      'SELECT id FROM returns WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [returnId, tenantId],
    )
    if (existing.rowCount) return

    const saleResult = await client.query(
      `SELECT id, sale_number, customer_id, shift_id, cashier_id, completed_at, payment_method, cash_amount, total
       FROM sales
       WHERE id = $1 AND tenant_id = $2 AND status IN ('completed', 'returned')
       FOR UPDATE`,
      [saleId, tenantId],
    )
    const sale = saleResult.rows[0]
    if (!sale) throw new AppError('SYNC_SALE_NOT_FOUND', 'Чек для повернення не знайдено', 404)

    const preparedItems: Array<{
      id: string
      saleItemId: string
      productId: string
      quantity: number
      unitPrice: number
      total: number
      condition: string
    }> = []

    for (const item of items) {
      const productId = String(item?.product_id ?? '')
      const quantity = Number(item?.quantity ?? 0)
      if (!isUuid(productId) || !Number.isFinite(quantity) || quantity <= 0) {
        throw new AppError('SYNC_RETURN_ITEM_INVALID', 'Некоректна позиція повернення', 400)
      }
      const requestedSaleItemId = isUuid(item?.sale_item_id) ? item.sale_item_id : null
      const saleItemResult = await client.query(
        `SELECT si.id, si.product_id, si.qty, si.unit_price,
                COALESCE((
                  SELECT SUM(ri.quantity)
                  FROM return_items ri
                  JOIN returns r ON r.id = ri.return_id
                  WHERE ri.sale_item_id = si.id AND r.tenant_id = $2
                ), 0) AS returned_qty
         FROM sale_items si
         WHERE si.sale_id = $1
           AND si.tenant_id = $2
           AND si.product_id = $3
           AND ($4::uuid IS NULL OR si.id = $4 OR NOT EXISTS (
             SELECT 1 FROM sale_items exact_item WHERE exact_item.id = $4 AND exact_item.sale_id = $1
           ))
         ORDER BY CASE WHEN si.id = $4 THEN 0 ELSE 1 END, si.created_at ASC
         LIMIT 1
         FOR UPDATE OF si`,
        [saleId, tenantId, productId, requestedSaleItemId],
      )
      const saleItem = saleItemResult.rows[0]
      if (!saleItem) throw new AppError('SYNC_RETURN_ITEM_NOT_FOUND', 'Позицію чека для повернення не знайдено', 404)
      const available = Number(saleItem.qty ?? 0) - Number(saleItem.returned_qty ?? 0)
      if (quantity > available) {
        throw new AppError('SYNC_RETURN_QTY_INVALID', `Для товару доступно до повернення: ${Math.max(0, available)}`, 422)
      }
      const unitPrice = Math.round(Number(saleItem.unit_price ?? 0))
      const alreadyPrepared = preparedItems.find((prepared) => prepared.saleItemId === saleItem.id)
      if (alreadyPrepared) {
        if (alreadyPrepared.quantity + quantity > available) {
          throw new AppError('SYNC_RETURN_QTY_INVALID', 'Для товару доступно до повернення: ' + Math.max(0, available), 422)
        }
        alreadyPrepared.quantity += quantity
        alreadyPrepared.total = Math.round(alreadyPrepared.quantity * alreadyPrepared.unitPrice)
        continue
      }
      preparedItems.push({
        id: isUuid(item?.id) ? item.id : randomUUID(),
        saleItemId: saleItem.id,
        productId,
        quantity,
        unitPrice,
        total: Math.max(0, Math.round(quantity * unitPrice)),
        condition: allowedConditions.has(String(item?.condition)) ? String(item.condition) : 'good',
      })
    }

    const calculatedRefund = preparedItems.reduce((sum, item) => sum + item.total, 0)
    const refund = calculatedRefund
    await client.query(
      `INSERT INTO returns (
        id, tenant_id, sale_id, customer_id, return_type, reason, reason_text,
        reason_note, refund_amount, refund_kopecks, refund_method, stock_action,
        status, created_by, approved_by, fiscal_number, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,'customer_return',$5,$6,$6,$7,$7,$8,$9,
        'completed',$10,$10,$11,$12,$13
      )`,
      [
        returnId,
        tenantId,
        saleId,
        sale.customer_id ?? null,
        reason,
        payload.reason_note ?? null,
        refund,
        refundMethod,
        stockAction,
        uuidOr(payload.approved_by, userId),
        payload.fiscal_number ?? null,
        createdAt,
        appliedAt,
      ],
    )

    await client.query(`SELECT set_config('app.stock_source_type', 'return', true)`)
    await client.query(`SELECT set_config('app.stock_source_id', $1, true)`, [returnId])
    for (const item of preparedItems) {
      await client.query(
        `INSERT INTO return_items (
          id, tenant_id, return_id, product_id, sale_item_id, quantity,
          unit_price_kopecks, total_kopecks, condition, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          item.id, tenantId, returnId, item.productId, item.saleItemId,
          item.quantity, item.unitPrice, item.total, item.condition, createdAt,
        ],
      )
      if (stockAction === 'return_to_stock') {
        await client.query(
          'UPDATE products SET qty_on_hand = qty_on_hand + $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
          [item.quantity, appliedAt, item.productId, tenantId],
        )
      }
    }

    if (refundMethod === 'cash' && refund > 0) {
      returnShiftId = returnShiftId ?? (isUuid(sale.shift_id) ? String(sale.shift_id) : null)
      let validShift: { rowCount: number | null; rows: Array<Record<string, any>> } = returnShiftId ? await client.query(
        `SELECT id FROM shifts
         WHERE id = $1 AND tenant_id = $2
           AND opened_at <= $3
           AND (closed_at IS NULL OR closed_at >= $3)
         LIMIT 1
         FOR UPDATE`,
        [returnShiftId, tenantId, createdAt],
      ) : { rowCount: 0, rows: [] }

      // Older desktop builds could keep selling after a locally open shift had already
      // closed on the server. Move that sale into a clearly marked reconciliation
      // shift instead of appending cash to a closed historical shift.
      if (!validShift.rowCount) {
        const reconciliationShiftId = randomUUID()
        const saleCash = sale.payment_method === 'cash'
          ? Math.max(0, Number(sale.cash_amount ?? sale.total ?? 0))
          : Math.max(0, Number(sale.cash_amount ?? 0))
        const openingCash = Math.max(0, refund - saleCash)
        const expectedCash = Math.max(0, openingCash + saleCash - refund)
        await client.query(
          `INSERT INTO shifts (
             id, tenant_id, cashier_id, status, opening_cash, closing_cash,
             expected_cash, cash_variance, opened_at, closed_at, notes, created_at, updated_at
           ) VALUES ($1,$2,$3,'closed',$4,$5,$5,0,LEAST($6::timestamptz,$7::timestamptz),$7,$8,LEAST($6::timestamptz,$7::timestamptz),$9)`,
          [
            reconciliationShiftId, tenantId, uuidOr(sale.cashier_id, userId),
            openingCash, expectedCash, sale.completed_at ?? createdAt, createdAt,
            'Автоматична звірка офлайн-продажу та повернення після закриття старої зміни',
            appliedAt,
          ],
        )
        await client.query(
          'UPDATE sales SET shift_id = $1, updated_at = $4 WHERE id = $2 AND tenant_id = $3',
          [reconciliationShiftId, saleId, tenantId, appliedAt],
        )
        returnShiftId = reconciliationShiftId
        validShift = { rowCount: 1, rows: [{ id: reconciliationShiftId }] }
      }

      const cashBalance = await client.query(
        `SELECT GREATEST(0,
           COALESCE(s.opening_cash, 0)
           + COALESCE((SELECT SUM(CASE
               WHEN sale.payment_method = 'cash' THEN COALESCE(NULLIF(sale.cash_amount, 0), sale.total)
               ELSE COALESCE(sale.cash_amount, 0)
             END)
             FROM sales sale
             WHERE sale.tenant_id = $2 AND sale.shift_id = s.id AND sale.status IN ('completed','returned')), 0)
           + COALESCE((SELECT SUM(CASE WHEN op.type = 'in' THEN op.amount ELSE -op.amount END)
             FROM cash_operations op WHERE op.tenant_id = $2 AND op.shift_id = s.id), 0)
         )::bigint AS available
         FROM shifts s WHERE s.id = $1 AND s.tenant_id = $2`,
        [returnShiftId, tenantId],
      )
      const availableCash = Number(cashBalance.rows[0]?.available ?? 0)
      if (availableCash < refund) {
        throw new AppError('CASHBOX_INSUFFICIENT_FUNDS', `У касі недостатньо готівки: доступно ${(availableCash / 100).toFixed(2)} грн`, 409)
      }
      await client.query(
        `INSERT INTO cash_operations (
          id, tenant_id, shift_id, type, amount, note, source, created_by, created_at, updated_at
        ) VALUES ($1,$2,$3,'out',$4,$5,'cashbox',$6,$7,$8)
        ON CONFLICT (id) DO NOTHING`,
        [
          returnId,
          tenantId,
          returnShiftId,
          refund,
          `Повернення за чеком ${sale.sale_number ?? saleId.slice(0, 8)}`,
          uuidOr(payload.approved_by, userId),
          createdAt,
          appliedAt,
        ],
      )
    } else if (sale.customer_id && refundMethod === 'debt_reduction' && refund > 0) {
      await client.query(
        `UPDATE customers
         SET debt_balance = GREATEST(0, COALESCE(debt_balance, 0) - $1), updated_at = $2
         WHERE id = $3 AND tenant_id = $4`,
        [refund, appliedAt, sale.customer_id, tenantId],
      )
    } else if (sale.customer_id && refundMethod === 'credit' && refund > 0) {
      const customerResult = await client.query(
        `UPDATE customers
         SET deposit_balance = COALESCE(deposit_balance, 0) + $1, updated_at = $2
         WHERE id = $3 AND tenant_id = $4
         RETURNING deposit_balance`,
        [refund, appliedAt, sale.customer_id, tenantId],
      )
      const balanceAfter = Number(customerResult.rows[0]?.deposit_balance ?? 0)
      await client.query(
        `INSERT INTO customer_deposit_transactions (
          id, tenant_id, customer_id, amount, balance_after, method, sale_id,
          shift_id, notes, created_by, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,'return_credit',$6,$7,$8,$9,$10,$11)
        ON CONFLICT (id) DO NOTHING`,
        [
          returnId,
          tenantId,
          sale.customer_id,
          refund,
          balanceAfter,
          saleId,
          returnShiftId,
          `Повернення за чеком ${sale.sale_number ?? saleId.slice(0, 8)}`,
          uuidOr(payload.approved_by, userId),
          createdAt,
          appliedAt,
        ],
      )
    }

    const returnedOrderItems = await client.query(
      `WITH returned_by_item AS (
         SELECT ri.sale_item_id, SUM(ri.quantity) AS qty
         FROM return_items ri
         JOIN returns r ON r.id = ri.return_id
         WHERE r.sale_id = $1 AND r.tenant_id = $2
         GROUP BY ri.sale_item_id
       ), fully_returned_products AS (
         SELECT si.product_id
         FROM sale_items si
         LEFT JOIN returned_by_item returned ON returned.sale_item_id = si.id
         WHERE si.sale_id = $1 AND si.tenant_id = $2
         GROUP BY si.product_id
         HAVING COALESCE(SUM(returned.qty), 0) >= SUM(si.qty)
       )
       UPDATE customer_order_items coi
       SET item_status = 'returned'
       WHERE coi.order_id = (
         SELECT id FROM customer_orders
         WHERE sale_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         LIMIT 1
       )
         AND coi.product_id IN (SELECT product_id FROM fully_returned_products)
         AND coi.item_status <> 'returned'
       RETURNING coi.id, coi.product_id`,
      [saleId, tenantId],
    )
    if (returnedOrderItems.rowCount) {
      const orderResult = await client.query(
        'SELECT id FROM customer_orders WHERE sale_id = $1 AND tenant_id = $2 LIMIT 1',
        [saleId, tenantId],
      )
      const orderId = orderResult.rows[0]?.id
      if (orderId) {
        await client.query(
          'UPDATE customer_orders SET updated_at = $3 WHERE id = $1 AND tenant_id = $2',
          [orderId, tenantId, appliedAt],
        )
        await client.query(
          `INSERT INTO order_activity_log (order_id, user_id, action, details)
           VALUES ($1,$2,'items_returned',$3::jsonb)`,
          [orderId, userId, JSON.stringify({
            return_id: returnId,
            product_ids: returnedOrderItems.rows.map((row) => row.product_id),
          })],
        )
      }
    }

    const remainingResult = await client.query(
      `SELECT COALESCE(SUM(GREATEST(si.qty - COALESCE(returned.qty, 0), 0)), 0) AS remaining
       FROM sale_items si
       LEFT JOIN (
         SELECT ri.sale_item_id, SUM(ri.quantity) AS qty
         FROM return_items ri
         JOIN returns r ON r.id = ri.return_id
         WHERE r.sale_id = $1 AND r.tenant_id = $2
         GROUP BY ri.sale_item_id
       ) returned ON returned.sale_item_id = si.id
       WHERE si.sale_id = $1 AND si.tenant_id = $2`,
      [saleId, tenantId],
    )
    if (Number(remainingResult.rows[0]?.remaining ?? 0) <= 0) {
      await client.query(
        "UPDATE sales SET status = 'returned', updated_at = $3 WHERE id = $1 AND tenant_id = $2",
        [saleId, tenantId, appliedAt],
      )
    }
  })

  const { data: storedReturnItems, error: storedReturnItemsError } = await db
    .from('return_items')
    .select('product_id, quantity, sale_item_id')
    .eq('return_id', returnId)
    .eq('tenant_id', tenantId)
  if (storedReturnItemsError) {
    throw new AppError('SYNC_RETURN_COMMISSION_ITEMS_FAILED', 'Не вдалося прочитати позиції повернення для сторно комісії', 500)
  }
  const { reverseCommissionForReturn } = await import('../commissionService.js')
  await reverseCommissionForReturn(
    returnId,
    saleId,
    (storedReturnItems ?? []).map((item) => ({
      product_id: item.product_id,
      quantity: Number(item.quantity),
      sale_item_id: item.sale_item_id,
    })),
    tenantId,
    userId,
  )
}

export async function applySuspendedSale(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const saleId = String(payload.id ?? operation.aggregate_id)
  const shiftId = String(payload.shift_id ?? '')
  const items = Array.isArray(payload.items) ? payload.items : []
  if (!isUuid(saleId) || !isUuid(shiftId) || items.length === 0) {
    throw new AppError('SYNC_SUSPENDED_SALE_INVALID', 'Некоректний відкладений чек', 400)
  }
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at

  await runTransaction(async (client) => {
    const existing = await client.query(
      'SELECT id FROM sales WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [saleId, tenantId],
    )
    if (existing.rowCount) return

    const cashierId = uuidOr(payload.cashier_id ?? payload.manager_id, userId)
    const shift = await client.query(
      'SELECT id FROM shifts WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [shiftId, tenantId],
    )
    if (!shift.rowCount) {
      await client.query(
        `INSERT INTO shifts (
          id, tenant_id, cashier_id, status, opening_cash, opened_at, notes, created_at, updated_at
        ) VALUES ($1,$2,$3,'open',0,$4,$5,$4,$6)`,
        [shiftId, tenantId, cashierId, createdAt, 'Створено під час офлайн-синхронізації', appliedAt],
      )
    }

    const subtotal = Math.max(0, Math.round(Number(payload.subtotal ?? 0)))
    const total = Math.max(0, Math.round(Number(payload.total ?? subtotal)))
    await client.query(
      `INSERT INTO sales (
        id, tenant_id, sale_number, customer_id, cashier_id, shift_id, status,
        subtotal, discount, total, payment_method, is_debt, notes, manager_id,
        cash_amount, card_amount, pickup_cell, completed_at, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,'suspended',
        $7,0,$8,$9,false,$10,$11,
        0,0,$12,$13,$13,$14
      )`,
      [
        saleId,
        tenantId,
        payload.sale_number ?? `S-${saleId.slice(0, 8)}`,
        isUuid(payload.customer_id) ? payload.customer_id : null,
        cashierId,
        shiftId,
        subtotal,
        total,
        normalizePaymentMethod(payload.payment_method),
        payload.notes ?? null,
        uuidOr(payload.manager_id, cashierId),
        payload.pickup_cell ?? null,
        createdAt,
        appliedAt,
      ],
    )

    for (const item of items) {
      const productId = String(item?.product_id ?? '')
      const qty = Number(item?.qty ?? 0)
      if (!isUuid(productId) || !Number.isFinite(qty) || qty <= 0) continue
      const product = await client.query(
        'SELECT purchase_price FROM products WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1',
        [productId, tenantId],
      )
      if (!product.rowCount) throw new AppError('SYNC_PRODUCT_NOT_FOUND', `Товар не знайдено: ${productId}`, 404)
      const unitPrice = Math.max(0, Math.round(Number(item?.unit_price ?? 0)))
      const discount = Math.max(0, Math.round(Number(item?.discount ?? 0)))
      const lineTotal = Math.max(0, Math.round(Number(item?.total ?? qty * unitPrice - discount)))
      await client.query(
        `INSERT INTO sale_items (
          id, tenant_id, sale_id, product_id, qty, unit_price, discount, total, cost_price
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          isUuid(item?.id) ? item.id : randomUUID(),
          tenantId,
          saleId,
          productId,
          qty,
          unitPrice,
          discount,
          lineTotal,
          Math.max(0, Math.round(Number(item?.purchase_price ?? product.rows[0].purchase_price ?? 0))),
        ],
      )
    }
  })
}

export async function applySuspendedSaleClosed(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  await runTransaction(async (client) => {
    await client.query(
      "UPDATE sales SET status = 'cancelled', updated_at = $3 WHERE id = $1 AND tenant_id = $2 AND status = 'suspended'",
      [operation.aggregate_id, tenantId, operation.applied_at ?? operation.created_at],
    )
  })
}

export async function applyShiftOpened(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const createdAt = payload.created_at ?? operation.created_at
  const openedAt = payload.opened_at ?? createdAt
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    const existing = await client.query(
      'SELECT id FROM shifts WHERE id = $1 AND tenant_id = $2',
      [operation.aggregate_id, tenantId],
    )
    if (existing.rowCount && existing.rowCount > 0) return

    await client.query(
      `INSERT INTO shifts (
        id, tenant_id, cashier_id, status, opening_cash, opened_at, notes, created_at, updated_at
      )
      VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8)`,
      [
        operation.aggregate_id,
        tenantId,
        payload.cashier_id,
        Number(payload.opening_cash ?? 0),
        openedAt,
        payload.notes ?? null,
        createdAt,
        appliedAt,
      ],
    )
  })
}

export async function applyShiftClosed(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const closedAt = payload.closed_at ?? payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    const result = await client.query(
      `UPDATE shifts
       SET status = 'closed', closing_cash = $3, expected_cash = $4,
           cash_variance = $5, closed_at = $6, notes = COALESCE($7, notes), updated_at = $8
       WHERE id = $1 AND tenant_id = $2`,
      [
        operation.aggregate_id,
        tenantId,
        Number(payload.closing_cash ?? 0),
        Number(payload.expected_cash ?? 0),
        Number(payload.cash_variance ?? 0),
        closedAt,
        payload.notes ?? null,
        appliedAt,
      ],
    )
    if (!result.rowCount) {
      throw new AppError('SYNC_SHIFT_NOT_FOUND', 'Зміну для закриття не знайдено', 404)
    }
  })
}

export async function applySaleCompleted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  await runTransaction(async (client) => {
    const saleId = String(payload.sale_id ?? operation.aggregate_id)
    const existing = await client.query(
      'SELECT id FROM sales WHERE id = $1 AND tenant_id = $2',
      [saleId, tenantId],
    )
    if (existing.rowCount) return

    const payments = Array.isArray(payload.payments) ? payload.payments : []
    const cashAmount = sumPayments(payments, 'cash')
    const cardAmount = sumPayments(payments, 'card')
    const transferAmount = sumPayments(payments, 'transfer')
    const debtAmount = sumPayments(payments, 'debt')
    const paymentMethod = normalizePaymentMethod(payload.payment_method)
    const completedAt = payload.completed_at ?? operation.created_at
    const appliedAt = operation.applied_at ?? operation.created_at
    let shiftId = isUuid(payload.shift_id) ? String(payload.shift_id) : null
    if (!shiftId) throw new AppError('SYNC_SALE_SHIFT_REQUIRED', 'Для продажу не вказано касову зміну', 422)
    const shift = await client.query(
      'SELECT id, status, opened_at, closed_at FROM shifts WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [shiftId, tenantId],
    )
    if (!shift.rowCount) {
      await client.query(
        `INSERT INTO shifts (
          id, tenant_id, cashier_id, status, opening_cash, opened_at, notes, created_at, updated_at
        ) VALUES ($1, $2, $3, 'open', 0, $4, $5, $4, $6)`,
        [shiftId, tenantId, uuidOr(payload.cashier_id, userId), completedAt, 'Створено під час офлайн-синхронізації', appliedAt],
      )
    } else {
      const row = shift.rows[0]
      const completedTime = new Date(completedAt).getTime()
      const outsideInterval = completedTime < new Date(row.opened_at).getTime()
        || (row.closed_at && completedTime > new Date(row.closed_at).getTime())
      if (outsideInterval) {
        shiftId = randomUUID()
        const expectedCash = Math.max(0, cashAmount)
        await client.query(
          `INSERT INTO shifts (
             id, tenant_id, cashier_id, status, opening_cash, closing_cash,
             expected_cash, cash_variance, opened_at, closed_at, notes, created_at, updated_at
           ) VALUES ($1,$2,$3,'closed',0,$4,$4,0,$5,$5,$6,$5,$7)`,
          [
            shiftId, tenantId, uuidOr(payload.cashier_id, userId), expectedCash, completedAt,
            'Автоматична звірка офлайн-продажу після закриття старої зміни',
            appliedAt,
          ],
        )
      }
    }
    const bonusesSpent = Math.max(0, Math.round(Number(payload.bonuses_spent ?? 0)))
    const fiscalNumber = payload.fiscal_number
      ?? payments.find((payment: { fiscal_number?: string | null }) => payment?.fiscal_number)?.fiscal_number
      ?? null
    const isFiscal = payload.is_fiscal === true || fiscalNumber !== null

    await client.query(
      `INSERT INTO sales (
        id, tenant_id, sale_number, customer_id, cashier_id, shift_id, status,
        subtotal, discount, total, payment_method, is_debt, notes, manager_id,
        cash_amount, card_amount, transfer_amount, bonuses_spent, is_fiscal, fiscal_number, fiscal_qr_url,
        completed_at, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, 'completed',
        $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20,
        $21, $21, $22
      )`,
      [
        saleId,
        tenantId,
        payload.sale_number,
        isUuid(payload.customer_id) ? payload.customer_id : null,
        uuidOr(payload.cashier_id, userId),
        shiftId,
        Number(payload.subtotal ?? 0),
        Number(payload.discount ?? 0),
        Number(payload.total ?? 0),
        paymentMethod,
        debtAmount > 0 || paymentMethod === 'debt',
        payload.notes ?? null,
        uuidOr(payload.manager_id ?? payload.cashier_id, userId),
        cashAmount,
        cardAmount,
        transferAmount,
        bonusesSpent,
        isFiscal,
        fiscalNumber,
        payload.fiscal_qr_url ?? null,
        completedAt,
        appliedAt,
      ],
    )

    await client.query(`SELECT set_config('app.stock_source_type', 'sale', true)`)
    await client.query(`SELECT set_config('app.stock_source_id', $1, true)`, [saleId])
    for (const item of payload.items ?? []) {
      const productId = item.product_id ?? await ensureFreeAmountProduct(client, tenantId)
      const product = await client.query(
        `SELECT id, is_service, COALESCE(purchase_price, 0) AS purchase_price,
                requires_core_return, COALESCE(core_deposit_amount, 0) AS core_deposit_amount
         FROM products
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [productId, tenantId],
      )
      if (!product.rowCount) {
        throw new AppError('SYNC_PRODUCT_NOT_FOUND', `Товар не знайдено: ${productId}`, 404)
      }

      const qty = Number(item.qty ?? 0)
      if (!Number.isFinite(qty) || qty <= 0) throw new AppError('SYNC_SALE_QTY_INVALID', 'Кількість товару у чеку має бути більше нуля', 422)
      const unitPrice = Math.max(0, Math.round(Number(item.unit_price ?? 0)))
      const discount = Math.max(0, Math.round(Number(item.discount ?? 0)))
      const total = Math.max(0, Math.round(qty * unitPrice - discount))
      const isService = product.rows[0].is_service === true
      const costPrice = Number(item.purchase_price ?? product.rows[0].purchase_price ?? 0)
      const coreDepositAmount = product.rows[0].requires_core_return === true
        ? Number(product.rows[0].core_deposit_amount ?? 0)
        : 0

      await client.query(
        `INSERT INTO sale_items (
          id, tenant_id, sale_id, product_id, qty, unit_price, discount, total,
          cost_price, core_deposit_amount, core_return_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          isUuid(item.id) ? item.id : randomUUID(),
          tenantId,
          saleId,
          productId,
          qty,
          unitPrice,
          discount,
          total,
          costPrice,
          coreDepositAmount,
          coreDepositAmount > 0 ? 'pending' : 'none',
        ],
      )

      if (!isService) {
        await client.query(
          'UPDATE products SET qty_on_hand = qty_on_hand - $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
          [qty, appliedAt, productId, tenantId],
        )
      }
    }

    const customerId = isUuid(payload.customer_id) ? payload.customer_id : null
    if (debtAmount > 0 && customerId) {
      await client.query(
        'UPDATE customers SET debt_balance = debt_balance + $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
        [debtAmount, appliedAt, customerId, tenantId],
      )
    } else if (paymentMethod === 'debt' && customerId) {
      await client.query(
        'UPDATE customers SET debt_balance = debt_balance + $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
        [Number(payload.total ?? 0), appliedAt, customerId, tenantId],
      )
    }

    if (bonusesSpent > 0) {
      if (!customerId) throw new AppError('SYNC_BONUS_CUSTOMER_REQUIRED', 'Для списання бонусів потрібен клієнт', 422)
      const spent = await client.query(
        `UPDATE customers
         SET bonus_balance = COALESCE(bonus_balance, 0) - $1, updated_at = $2
         WHERE id = $3 AND tenant_id = $4 AND COALESCE(bonus_balance, 0) >= $1
         RETURNING bonus_balance`,
        [bonusesSpent, appliedAt, customerId, tenantId],
      )
      if (!spent.rowCount) {
        throw new AppError('SYNC_INSUFFICIENT_BONUS', 'На сервері недостатньо бонусів клієнта; спочатку синхронізуйте картку клієнта', 409)
      }
      await client.query(
        `INSERT INTO bonus_transactions (
          id, tenant_id, customer_id, amount, transaction_type, source_sale_id,
          description, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,'spend',$5,$6,$7,$8)`,
        [
          operation.operation_id,
          tenantId,
          customerId,
          -bonusesSpent,
          saleId,
          `Списання бонусів за чеком ${payload.sale_number ?? saleId.slice(0, 8)}`,
          completedAt,
          appliedAt,
        ],
      )
    }
  })
}
