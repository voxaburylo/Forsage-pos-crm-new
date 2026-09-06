/**
 * Винесено з `syncService.ts` без зміни поведінки — див. `REFACTOR_PLAN.md`,
 * ітерація 4. У файлі на 4900 рядків помилку не видно очима.
 */

import { runTransaction } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import { addOrderPayment } from '../orderPaymentService.js'
import { ORDER_STATUS_TRANSITIONS, isUuid, uuidOr } from './syncCore.js'
import type { SyncOutboxOperation } from './syncCore.js'
import { randomUUID } from 'node:crypto'

export async function applyOrderUpsert(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const orderId = String(payload.id ?? operation.aggregate_id)
  if (!isUuid(orderId)) throw new AppError('SYNC_ORDER_INVALID', 'Некоректний ідентифікатор замовлення', 400)
  const hasIncomingItems = Array.isArray(payload.items)
  const items = hasIncomingItems ? payload.items : []
  const timestamp = operation.applied_at ?? operation.created_at

  await runTransaction(async (client) => {
    const existingResult = await client.query(
      'SELECT * FROM customer_orders WHERE id = $1 AND tenant_id = $2 LIMIT 1 FOR UPDATE',
      [orderId, tenantId],
    )
    const existing = existingResult.rows[0] ?? null
    // A delayed editor snapshot must never reopen or rewrite a terminal order.
    if (existing && ['completed', 'canceled', 'archived'].includes(String(existing.status))) return
    const owns = (key: string): boolean => Object.prototype.hasOwnProperty.call(payload, key)
    const fromPayload = (key: string, fallback: any): any => owns(key) ? payload[key] : fallback
    const managerId = uuidOr(fromPayload('manager_id', existing?.manager_id), userId)
    const orderNumberValue = fromPayload('order_number', existing?.order_number ?? null)
    const orderNumber = Number.isFinite(Number(orderNumberValue)) ? Number(orderNumberValue) : null
    const requestedStatus = String(fromPayload('status', existing?.status ?? 'lead'))
    if (!new Set(['lead', 'quoted', 'new', 'in_progress', 'ordered', 'arrived', 'called', 'no_answer', 'ready']).has(requestedStatus)) {
      throw new AppError('SYNC_ORDER_STATUS_INVALID', 'Закриття замовлення виконується тільки окремою безпечною операцією', 409)
    }
    const exchangeSourceId = isUuid(fromPayload('exchange_source_order_id', existing?.exchange_source_order_id))
      ? String(fromPayload('exchange_source_order_id', existing?.exchange_source_order_id))
      : null
    if (!existing && exchangeSourceId) {
      const source = await client.query(
        `SELECT id FROM customer_orders
         WHERE id = $1 AND tenant_id = $2 AND status = 'completed' AND sale_id IS NOT NULL AND deleted_at IS NULL`,
        [exchangeSourceId, tenantId],
      )
      if (!source.rowCount) throw new AppError('SYNC_EXCHANGE_SOURCE_INVALID', 'Обмін можна створити тільки для виданого замовлення з чеком', 409)
    }

    await client.query(
      `INSERT INTO customer_orders (
        id, tenant_id, order_number, customer_id, chat_id, manager_id, vehicle_info,
        status, prepayment, prepayment_method, prepayment_is_fiscal, total_amount,
        total_paid, discount_amount, pickup_deadline_at, pickup_cell, comment, source,
        exchange_source_order_id, created_at, updated_at, deleted_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14,$15,$16,$17,$18,$19,$20,NULL
      )
      ON CONFLICT (id) DO UPDATE SET
        order_number = EXCLUDED.order_number,
        customer_id = EXCLUDED.customer_id,
        chat_id = EXCLUDED.chat_id,
        manager_id = EXCLUDED.manager_id,
        vehicle_info = EXCLUDED.vehicle_info,
        status = EXCLUDED.status,
        prepayment = EXCLUDED.prepayment,
        prepayment_method = EXCLUDED.prepayment_method,
        prepayment_is_fiscal = EXCLUDED.prepayment_is_fiscal,
        total_amount = EXCLUDED.total_amount,
        total_paid = EXCLUDED.total_paid,
        discount_amount = 0,
        pickup_deadline_at = EXCLUDED.pickup_deadline_at,
        pickup_cell = EXCLUDED.pickup_cell,
        comment = EXCLUDED.comment,
        source = EXCLUDED.source,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL
      WHERE customer_orders.tenant_id = EXCLUDED.tenant_id`,
      [
        orderId,
        tenantId,
        orderNumber,
        isUuid(fromPayload('customer_id', existing?.customer_id)) ? fromPayload('customer_id', existing?.customer_id) : null,
        isUuid(fromPayload('chat_id', existing?.chat_id)) ? fromPayload('chat_id', existing?.chat_id) : null,
        managerId,
        fromPayload('vehicle_info', existing?.vehicle_info ?? null),
        requestedStatus,
        Number(existing?.prepayment ?? 0),
        fromPayload('prepayment_method', existing?.prepayment_method ?? null),
        fromPayload('prepayment_is_fiscal', existing?.prepayment_is_fiscal ?? false) === true,
        Number(fromPayload('total_amount', existing?.total_amount ?? 0)),
        Number(existing?.total_paid ?? 0),
        fromPayload('pickup_deadline_at', existing?.pickup_deadline_at ?? null),
        fromPayload('pickup_cell', existing?.pickup_cell ?? null),
        fromPayload('comment', existing?.comment ?? null),
        fromPayload('source', existing?.source ?? 'walk_in'),
        exchangeSourceId,
        existing?.created_at ?? payload.created_at ?? timestamp,
        timestamp,
      ],
    )

    if (!hasIncomingItems && existing) return

    const incomingIds: string[] = []
    for (const item of items) {
      const itemId = isUuid(item?.id) ? item.id : randomUUID()
      const requestedItemStatus = String(item?.item_status ?? 'pending')
      if (!new Set(['pending', 'ordered', 'arrived', 'canceled']).has(requestedItemStatus)) {
        throw new AppError('SYNC_ORDER_ITEM_STATUS_INVALID', 'Видача або повернення позиції виконується тільки через касу', 409)
      }
      incomingIds.push(itemId)
      await client.query(
        `INSERT INTO customer_order_items (
          id, order_id, product_id, sku, name, supplier_id, source_type, item_type,
          item_status, buy_price, sell_price, qty, expected_date,
          core_deposit_amount, core_return_status, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (id) DO UPDATE SET
          product_id = EXCLUDED.product_id,
          sku = EXCLUDED.sku,
          name = EXCLUDED.name,
          supplier_id = EXCLUDED.supplier_id,
          source_type = EXCLUDED.source_type,
          item_type = EXCLUDED.item_type,
          item_status = EXCLUDED.item_status,
          buy_price = EXCLUDED.buy_price,
          sell_price = EXCLUDED.sell_price,
          qty = EXCLUDED.qty,
          expected_date = EXCLUDED.expected_date,
          core_deposit_amount = EXCLUDED.core_deposit_amount,
          core_return_status = EXCLUDED.core_return_status
        WHERE customer_order_items.order_id = EXCLUDED.order_id`,
        [
          itemId,
          orderId,
          isUuid(item?.product_id) ? item.product_id : null,
          item?.sku ?? null,
          String(item?.name ?? 'Товар'),
          isUuid(item?.supplier_id) ? item.supplier_id : null,
          item?.source_type === 'warehouse' ? 'warehouse' : 'supplier',
          item?.item_type === 'service' ? 'service' : 'product',
          requestedItemStatus,
          Number(item?.buy_price ?? 0),
          Number(item?.sell_price ?? 0),
          Number(item?.qty ?? 1),
          item?.expected_date ?? null,
          Number(item?.core_deposit_amount ?? 0),
          item?.core_return_status ?? 'none',
          item?.created_at ?? timestamp,
        ],
      )
    }

    if (incomingIds.length > 0) {
      await client.query(
        'DELETE FROM customer_order_items WHERE order_id = $1 AND NOT (id = ANY($2::uuid[]))',
        [orderId, incomingIds],
      )
    } else {
      await client.query('DELETE FROM customer_order_items WHERE order_id = $1', [orderId])
    }
  })
}

export async function applyOrderDeleted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  await runTransaction(async (client) => {
    const order = await client.query(
      `SELECT o.status, o.prepayment, o.total_paid, o.sale_id,
              COUNT(p.id)::integer AS payment_count,
              COALESCE(SUM(p.amount), 0)::bigint AS ledger_paid
       FROM customer_orders o
       LEFT JOIN order_payments p
         ON p.order_id = o.id AND p.tenant_id = o.tenant_id
       WHERE o.id = $1 AND o.tenant_id = $2 AND o.deleted_at IS NULL
       GROUP BY o.id
       FOR UPDATE OF o`,
      [operation.aggregate_id, tenantId],
    )
    if (!order.rowCount) return
    const row = order.rows[0]
    if (!['lead', 'quoted', 'new'].includes(String(row.status))
      || Number(row.prepayment ?? 0) !== 0
      || Number(row.total_paid ?? 0) !== 0
      || Number(row.payment_count ?? 0) !== 0
      || Number(row.ledger_paid ?? 0) !== 0
      || row.sale_id) {
      throw new AppError('SYNC_ORDER_DELETE_FORBIDDEN', 'Видалити можна лише неоплачений чернетковий заказ', 409)
    }
    await client.query(
      'UPDATE customer_orders SET deleted_at = $3, deleted_by = $4, updated_at = $3 WHERE id = $1 AND tenant_id = $2',
      [operation.aggregate_id, tenantId, operation.created_at, userId],
    )
    await client.query(
      `UPDATE inventory_reserves
       SET released_at = COALESCE(released_at, $3)
       WHERE order_id = $1 AND tenant_id = $2 AND released_at IS NULL`,
      [operation.aggregate_id, tenantId, operation.created_at],
    )
  })
}

export async function applyOrderStatusUpdated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const status = String(operation.payload?.status ?? '')
  const allowed = new Set(['lead', 'quoted', 'new', 'in_progress', 'ordered', 'arrived', 'called', 'no_answer', 'ready'])
  if (!allowed.has(status)) {
    throw new AppError('SYNC_ORDER_STATUS_INVALID', 'Видача та скасування замовлення виконуються окремою безпечною операцією', 409)
  }
  await runTransaction(async (client) => {
    const current = await client.query(
      `SELECT status FROM customer_orders WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [operation.aggregate_id, tenantId],
    )
    if (!current.rowCount || ['completed', 'canceled', 'archived'].includes(String(current.rows[0].status))) {
      throw new AppError('SYNC_ORDER_IMMUTABLE', 'Замовлення не знайдено або його вже закрито', 409)
    }
    const from = String(current.rows[0].status)
    if (from !== status && !(ORDER_STATUS_TRANSITIONS[from] ?? []).includes(status)) {
      throw new AppError('SYNC_ORDER_STATUS_TRANSITION_INVALID', 'Недоступний перехід статусу замовлення', 409)
    }
    await client.query('SELECT update_customer_order_status($1, $2, $3, $4)', [tenantId, operation.aggregate_id, status, userId])
  })
}

export async function applyOrderItemStatusUpdated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  if (!isUuid(payload.item_id)) throw new AppError('SYNC_ORDER_ITEM_INVALID', 'Некоректна позиція замовлення', 400)
  const itemStatus = String(payload.item_status ?? '')
  if (!new Set(['pending', 'ordered', 'arrived', 'canceled']).has(itemStatus)) {
    throw new AppError('SYNC_ORDER_ITEM_STATUS_INVALID', 'Видача або повернення позиції виконується тільки через касу', 409)
  }
  await runTransaction(async (client) => {
    const result = await client.query(
      `UPDATE customer_order_items i
       SET item_status = $3
       FROM customer_orders o
       WHERE i.id = $1 AND i.order_id = o.id AND o.tenant_id = $2 AND o.deleted_at IS NULL
         AND o.status NOT IN ('completed', 'canceled', 'archived')
       RETURNING i.order_id`,
      [payload.item_id, tenantId, itemStatus],
    )
    if (!result.rowCount) throw new AppError('SYNC_ORDER_ITEM_IMMUTABLE', 'Позицію не знайдено або замовлення вже закрито', 409)
    const orderId = result.rows[0].order_id
    const state = await client.query(
      `SELECT item_status, sell_price, qty, COALESCE(core_deposit_amount, 0) AS core_deposit_amount
       FROM customer_order_items WHERE order_id = $1`,
      [orderId],
    )
    const active = state.rows.filter((item) => item.item_status !== 'canceled')
    const total = active.reduce((sum, item) => sum + Number(item.sell_price) * Number(item.qty) + Number(item.core_deposit_amount) * Number(item.qty), 0)
    const nextStatus = active.length > 0 && active.every((item) => ['arrived', 'handed', 'returned'].includes(item.item_status))
      ? 'ready'
      : active.some((item) => item.item_status === 'ordered')
        ? 'ordered'
        : 'new'
    await client.query(
      'UPDATE customer_orders SET total_amount = $3, status = $4, updated_at = $5 WHERE id = $1 AND tenant_id = $2',
      [orderId, tenantId, total, nextStatus, operation.applied_at ?? operation.created_at],
    )
    if (itemStatus === 'canceled' || itemStatus === 'pending') {
      await client.query('SELECT reserve_order_items($1, $2, $3)', [tenantId, orderId, userId])
    }
  })
}

export async function applyOrderItemsArrived(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const ids = [...new Set((Array.isArray(operation.payload?.item_ids) ? operation.payload.item_ids : []).filter(isUuid))]
  if (ids.length === 0) return
  await runTransaction(async (client) => {
    const owned = await client.query(
      `SELECT i.id, i.order_id
       FROM customer_order_items i
       JOIN customer_orders o ON o.id = i.order_id
       WHERE i.id = ANY($1::uuid[])
         AND o.tenant_id = $2
         AND o.deleted_at IS NULL
         AND o.status NOT IN ('completed', 'canceled', 'archived')
       FOR UPDATE OF i`,
      [ids, tenantId],
    )
    if (owned.rowCount !== ids.length) {
      throw new AppError('SYNC_ORDER_ITEM_NOT_FOUND', 'Одна або кілька позицій не знайдені у вашому магазині', 404)
    }
    await client.query(
      `UPDATE customer_order_items i
       SET item_status = 'arrived'
       FROM customer_orders o
       WHERE i.id = ANY($1::uuid[])
         AND i.order_id = o.id
         AND o.tenant_id = $2
         AND o.deleted_at IS NULL`,
      [ids, tenantId],
    )
    await client.query(
      `UPDATE customer_orders SET updated_at = $3
       WHERE tenant_id = $2
         AND id = ANY($1::uuid[])`,
      [[...new Set(owned.rows.map((row) => row.order_id))], tenantId, operation.applied_at ?? operation.created_at],
    )
  })
}

export async function applyOrderCanceled(
  tenantId: string,
  userId: string,
  operation: SyncOutboxOperation,
): Promise<void> {
  const payload = operation.payload ?? {}
  await runTransaction(async (client) => {
    const orderResult = await client.query(
      `SELECT status, comment, total_paid, prepayment, customer_id, order_number
       FROM customer_orders
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [operation.aggregate_id, tenantId],
    )
    if (!orderResult.rowCount) throw new AppError('SYNC_ORDER_NOT_FOUND', 'Замовлення не знайдено', 404)
    const order = orderResult.rows[0]
    if (order.status === 'completed' || order.status === 'archived') {
      throw new AppError('SYNC_ORDER_COMPLETED', 'Завершене або архівне замовлення не можна скасувати', 409)
    }
    if (order.status === 'canceled') return

    const payments = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS paid_amount
       FROM order_payments
       WHERE order_id = $1 AND tenant_id = $2`,
      [operation.aggregate_id, tenantId],
    )
    const paidAmount = Math.max(
      Number(order.total_paid ?? 0),
      Number(order.prepayment ?? 0),
      Number(payments.rows[0]?.paid_amount ?? 0),
    )
    const timestamp = operation.applied_at ?? operation.created_at
    let customerBalance: number | null = null
    let creditedAmount = 0
    if (paidAmount > 0) {
      const customerId = String(order.customer_id ?? '')
      if (!customerId) {
        throw new AppError(
          'SYNC_ORDER_CUSTOMER_REQUIRED_FOR_CREDIT',
          'До оплаченого замовлення не прив’язаний клієнт',
          422,
        )
      }
      const existingCredit = await client.query(
        `SELECT amount, balance_after
         FROM customer_deposit_transactions
         WHERE id = $1 AND tenant_id = $2
         LIMIT 1`,
        [operation.aggregate_id, tenantId],
      )
      if (existingCredit.rowCount) {
        creditedAmount = Number(existingCredit.rows[0].amount ?? 0)
        customerBalance = Number(existingCredit.rows[0].balance_after ?? 0)
      } else {
        const customerResult = await client.query(
          `SELECT id, COALESCE(deposit_balance, 0) AS deposit_balance
           FROM customers
           WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
           LIMIT 1 FOR UPDATE`,
          [customerId, tenantId],
        )
        if (!customerResult.rowCount) {
          throw new AppError('SYNC_ORDER_CUSTOMER_NOT_FOUND', 'Клієнта замовлення не знайдено', 404)
        }
        customerBalance = Number(customerResult.rows[0].deposit_balance ?? 0) + paidAmount
        await client.query(
          `UPDATE customers
           SET deposit_balance = $3, updated_at = $4
           WHERE id = $1 AND tenant_id = $2`,
          [customerId, tenantId, customerBalance, timestamp],
        )
        await client.query(
          `INSERT INTO customer_deposit_transactions (
             id, tenant_id, customer_id, amount, balance_after, method, order_id,
             notes, created_by, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, 'account', $1, $6, $7, $8, $8)`,
          [
            operation.aggregate_id, tenantId, customerId, paidAmount, customerBalance,
            `Скасування замовлення №${String(order.order_number ?? operation.aggregate_id)}`,
            userId, timestamp,
          ],
        )
        creditedAmount = paidAmount
      }
    }

    const priorComment = String(order.comment ?? '').trim()
    const reason = String(payload.reason ?? '').trim()
    const comment = reason ? `${priorComment ? `${priorComment}\n` : ''}Скасування: ${reason}` : priorComment || null
    await client.query(
      `UPDATE customer_orders
       SET status = 'canceled', comment = $3, updated_at = $4
       WHERE id = $1 AND tenant_id = $2`,
      [operation.aggregate_id, tenantId, comment, timestamp],
    )
    await client.query(
      `UPDATE inventory_reserves SET released_at = $3
       WHERE order_id = $1 AND tenant_id = $2 AND released_at IS NULL`,
      [operation.aggregate_id, tenantId, timestamp],
    )
    await client.query(
      `UPDATE customer_order_items i
       SET item_status = 'canceled'
       FROM customer_orders o
       WHERE i.order_id = $1
         AND i.order_id = o.id
         AND o.tenant_id = $2
         AND i.item_status <> 'handed'`,
      [operation.aggregate_id, tenantId],
    )
    await client.query(
      `INSERT INTO order_activity_log (order_id, user_id, action, details, created_at)
       VALUES ($1, $2, 'canceled', $3::jsonb, $4)`,
      [
        operation.aggregate_id,
        userId,
        JSON.stringify({ reason: payload.reason ?? null, credited_amount: creditedAmount, customer_balance: customerBalance, source: 'desktop_sync' }),
        timestamp,
      ],
    )
  })
}

export async function applyOrderPaymentAdded(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const orderId = String(payload.order_id ?? operation.aggregate_id)
  const paymentId = String(payload.payment_id ?? operation.operation_id)
  const amount = Number(payload.amount ?? 0)
  const method = payload.method === 'card' || payload.method === 'transfer' || payload.method === 'account'
    ? payload.method
    : 'cash'
  const shiftId = isUuid(payload.shift_id) ? payload.shift_id : null
  const createdBy = isUuid(payload.created_by) ? payload.created_by : userId
  if (!isUuid(orderId) || !isUuid(paymentId) || !Number.isFinite(amount) || amount <= 0) {
    throw new AppError('SYNC_ORDER_PAYMENT_INVALID', 'Некоректний платіж замовлення', 400)
  }
  if (!shiftId) {
    throw new AppError('SYNC_ORDER_PAYMENT_SHIFT_REQUIRED', 'Для платежу не вказано касову зміну', 400)
  }

  await addOrderPayment({
    payment_id: paymentId,
    order_id: orderId,
    tenant_id: tenantId,
    user_id: createdBy,
    amount,
    method,
    is_fiscal: payload.is_fiscal === true,
    shift_id: shiftId,
    notes: typeof payload.notes === 'string' ? payload.notes : null,
    created_at: String(payload.created_at ?? operation.created_at),
    applied_at: operation.applied_at ?? operation.created_at,
    // Offline payment was validated while the local shift was open. It can reach
    // the server after that shift closed, so validate its timestamp interval.
    accept_closed_shift: true,
  })
}

export async function applyOrderCompleted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const orderId = String(payload.order_id ?? operation.aggregate_id)
  if (!isUuid(orderId)) {
    throw new AppError('SYNC_ORDER_COMPLETE_INVALID', 'Некоректна видача замовлення', 400)
  }

  await runTransaction(async (client) => {
    const orderResult = await client.query(
      `SELECT *
       FROM customer_orders
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [orderId, tenantId],
    )
    if (!orderResult.rowCount) {
      throw new AppError('SYNC_ORDER_NOT_FOUND', 'Замовлення не знайдено', 404)
    }
    const order = orderResult.rows[0]
    const linkedSaleId = isUuid(order.sale_id) ? String(order.sale_id) : null

    if (linkedSaleId) {
      const existingLinkedSale = await client.query(
        'SELECT id, tenant_id FROM sales WHERE id = $1 LIMIT 1',
        [linkedSaleId],
      )
      if (existingLinkedSale.rowCount && existingLinkedSale.rows[0].tenant_id !== tenantId) {
        throw new AppError('SYNC_SALE_TENANT_CONFLICT', 'Чек належить іншому магазину', 409)
      }
      if (existingLinkedSale.rowCount) {
        const appliedAt = operation.applied_at ?? operation.created_at
        await client.query(
          `UPDATE customer_order_items AS item
           SET item_status = 'handed'
           FROM customer_orders AS parent
           WHERE item.order_id = $1
             AND parent.id = item.order_id
             AND parent.tenant_id = $2
             AND item.item_status NOT IN ('canceled', 'handed')`,
          [orderId, tenantId],
        )
        await client.query(
          'UPDATE inventory_reserves SET released_at = COALESCE(released_at, $2) WHERE order_id = $1 AND tenant_id = $3 AND released_at IS NULL',
          [orderId, appliedAt, tenantId],
        )
        await client.query(
          `UPDATE customer_orders
           SET status = 'completed', updated_at = $3
           WHERE id = $1 AND tenant_id = $2`,
          [orderId, tenantId, appliedAt],
        )
        return
      }
    }

    if (order.status === 'canceled' || order.status === 'archived') {
      throw new AppError('SYNC_ORDER_INVALID_STATUS', 'Скасоване або архівне замовлення не можна видати', 409)
    }

    const paymentResult = await client.query(
      `SELECT method, COALESCE(SUM(amount), 0)::bigint AS amount
       FROM order_payments
       WHERE order_id = $1 AND tenant_id = $2
       GROUP BY method`,
      [orderId, tenantId],
    )
    const paymentTotals = { cash: 0, card: 0, transfer: 0 }
    for (const payment of paymentResult.rows) {
      const amount = Math.max(0, Math.round(Number(payment.amount ?? 0)))
      if (payment.method === 'card') paymentTotals.card += amount
      else if (payment.method === 'transfer' || payment.method === 'account') paymentTotals.transfer += amount
      else paymentTotals.cash += amount
    }
    const authoritativePaid = paymentTotals.cash + paymentTotals.card + paymentTotals.transfer
    const amountDue = Math.max(0, Number(order.total_amount ?? 0) - Number(order.discount_amount ?? 0))
    if (authoritativePaid !== amountDue) {
      const code = authoritativePaid > amountDue ? 'SYNC_ORDER_OVERPAID' : 'SYNC_ORDER_INCOMPLETE_PAYMENT'
      const message = authoritativePaid > amountDue
        ? 'Оплата перевищує суму замовлення. Спочатку поверніть або зарахуйте надлишок.'
        : 'Не всі оплати проведено через касу'
      throw new AppError(code, message, 409)
    }

    const itemResult = await client.query(
      `SELECT item.id, item.product_id, item.name, item.sku, item.qty,
              item.sell_price, item.buy_price, item.core_deposit_amount,
              item.core_return_status, item.item_status
       FROM customer_order_items AS item
       JOIN customer_orders AS parent ON parent.id = item.order_id
       WHERE item.order_id = $1
         AND parent.tenant_id = $2
         AND item.item_status <> 'canceled'
       ORDER BY item.created_at ASC
       FOR UPDATE OF item`,
      [orderId, tenantId],
    )
    if (!itemResult.rowCount) {
      throw new AppError('SYNC_ORDER_EMPTY', 'У замовленні немає активних позицій для видачі', 422)
    }

    const unlinked = itemResult.rows.filter((item) => !isUuid(item.product_id))
    if (unlinked.length > 0) {
      const names = unlinked.slice(0, 3).map((item) => `«${item.name || 'Без назви'}»`).join(', ')
      const suffix = unlinked.length > 3 ? ` та ще ${unlinked.length - 3}` : ''
      throw new AppError(
        'SYNC_ORDER_ITEM_NOT_LINKED',
        `Не можна видати замовлення. Не прив'язано до картки товару: ${names}${suffix}. Виберіть товар у кожній позиції.`,
        422,
      )
    }

    const allowNegativeResult = await client.query(
      'SELECT COALESCE((SELECT allow_negative_qty FROM shop_settings WHERE tenant_id = $1 LIMIT 1), false) AS allow_negative',
      [tenantId],
    )
    const allowNegative = allowNegativeResult.rows[0]?.allow_negative !== false
    const payloadItems = Array.isArray(payload.items) ? payload.items : []
    const payloadByOrderItem = new Map<string, any>(
      payloadItems
        .filter((item: any) => item?.order_item_id)
        .map((item: any) => [String(item.order_item_id), item]),
    )

    let subtotal = 0
    const items: Array<{
      id: string
      order_item_id: string
      product_id: string
      qty: number
      unit_price: number
      purchase_price: number
      discount: number
      total: number
      core_deposit_amount: number
      core_return_status: string
      is_service: boolean
    }> = []

    for (const orderItem of itemResult.rows) {
      const productResult = await client.query(
        `SELECT id, name, sku, qty_on_hand, is_service, purchase_price,
                requires_core_return, core_deposit_amount
         FROM products
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [orderItem.product_id, tenantId],
      )
      if (!productResult.rowCount) {
        throw new AppError(
          'SYNC_PRODUCT_NOT_FOUND',
          `Товар «${orderItem.name || orderItem.product_id}» не знайдено`,
          404,
        )
      }

      const product = productResult.rows[0]
      const qty = Number(orderItem.qty ?? 0)
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new AppError('SYNC_ORDER_QTY_INVALID', `Некоректна кількість у позиції «${orderItem.name || product.name}»`, 422)
      }
      const unitPrice = Math.round(Number(orderItem.sell_price ?? 0))
      const merchandiseTotal = Math.round(unitPrice * qty)
      const isService = product.is_service === true
      if (!isService && !allowNegative && Number(product.qty_on_hand ?? 0) < qty) {
        throw new AppError(
          'INSUFFICIENT_STOCK',
          `Недостатньо залишку для «${product.name}»: є ${Number(product.qty_on_hand ?? 0)}, потрібно ${qty}`,
          422,
        )
      }

      const payloadItem = payloadByOrderItem.get(String(orderItem.id))
      const rawCoreDepositAmount = Number(
        orderItem.core_deposit_amount
          ?? (product.requires_core_return === true ? product.core_deposit_amount : 0)
          ?? 0,
      )
      const coreDepositAmount = Number.isFinite(rawCoreDepositAmount)
        ? Math.max(0, Math.round(rawCoreDepositAmount))
        : 0
      const lineTotal = merchandiseTotal + Math.round(coreDepositAmount * qty)
      subtotal += lineTotal
      items.push({
        id: isUuid(payloadItem?.id) ? payloadItem.id : randomUUID(),
        order_item_id: String(orderItem.id),
        product_id: String(product.id),
        qty,
        unit_price: unitPrice,
        purchase_price: Math.round(Number(orderItem.buy_price ?? product.purchase_price ?? 0)),
        discount: 0,
        total: lineTotal,
        core_deposit_amount: coreDepositAmount,
        core_return_status: String(
          orderItem.core_return_status && orderItem.core_return_status !== 'none'
            ? orderItem.core_return_status
            : coreDepositAmount > 0 ? 'pending' : 'none',
        ),
        is_service: isService,
      })
    }

    const cashierId = uuidOr(payload.cashier_id, userId)
    let shiftId = isUuid(payload.shift_id) ? String(payload.shift_id) : null
    if (shiftId) {
      const shift = await client.query(
        'SELECT id, tenant_id FROM shifts WHERE id = $1 LIMIT 1',
        [shiftId],
      )
      if (shift.rowCount && shift.rows[0].tenant_id !== tenantId) {
        throw new AppError('SYNC_SHIFT_TENANT_CONFLICT', 'Касова зміна належить іншому магазину', 409)
      }
      if (!shift.rowCount) {
        const appliedAt = operation.applied_at ?? operation.created_at
        await client.query(
          `INSERT INTO shifts (
            id, tenant_id, cashier_id, status, opening_cash, opened_at, notes, created_at
          ) VALUES ($1, $2, $3, 'open', 0, $4, $5, $4)`,
          [shiftId, tenantId, cashierId, appliedAt, 'Створено під час офлайн-видачі замовлення'],
        )
      }
    } else {
      const shift = await client.query(
        `SELECT id FROM shifts
         WHERE tenant_id = $1 AND status = 'open'
         ORDER BY opened_at DESC
         LIMIT 1`,
        [tenantId],
      )
      shiftId = shift.rowCount ? String(shift.rows[0].id) : null
    }
    if (!shiftId) throw new AppError('SYNC_OPEN_SHIFT_REQUIRED', 'Спочатку відкрийте касову зміну', 422)

    const saleId = isUuid(payload.sale_id)
      ? String(payload.sale_id)
      : linkedSaleId ?? randomUUID()
    const existingSale = await client.query(
      'SELECT id, tenant_id FROM sales WHERE id = $1 LIMIT 1',
      [saleId],
    )
    if (existingSale.rowCount && existingSale.rows[0].tenant_id !== tenantId) {
      throw new AppError('SYNC_SALE_TENANT_CONFLICT', 'Чек належить іншому магазину', 409)
    }
    if (existingSale.rowCount) {
      const otherOrder = await client.query(
        `SELECT id FROM customer_orders
         WHERE tenant_id = $1 AND sale_id = $2 AND id <> $3
         LIMIT 1`,
        [tenantId, saleId, orderId],
      )
      if (otherOrder.rowCount) {
        throw new AppError('SYNC_SALE_ALREADY_LINKED', 'Цей чек уже прив’язано до іншого замовлення', 409)
      }
      const appliedAt = operation.applied_at ?? operation.created_at
      await client.query(
        `UPDATE customer_order_items AS item
         SET item_status = 'handed'
         FROM customer_orders AS parent
         WHERE item.order_id = $1
           AND parent.id = item.order_id
           AND parent.tenant_id = $2
           AND item.item_status NOT IN ('canceled', 'handed')`,
        [orderId, tenantId],
      )
      await client.query(
        `UPDATE customer_orders
         SET status = 'completed', sale_id = $3, updated_at = $4
         WHERE id = $1 AND tenant_id = $2`,
        [orderId, tenantId, saleId, appliedAt],
      )
      await client.query(
        'UPDATE inventory_reserves SET released_at = COALESCE(released_at, $2) WHERE order_id = $1 AND tenant_id = $3 AND released_at IS NULL',
        [orderId, appliedAt, tenantId],
      )
      return
    }

    let saleNumber = String(payload.sale_number ?? '').trim()
    if (!saleNumber) {
      const sequence = await client.query("SELECT LPAD(nextval('sale_number_seq')::TEXT, 6, '0') AS sale_number")
      saleNumber = String(sequence.rows[0].sale_number)
    }

    const usedPaymentMethods = [
      paymentTotals.cash > 0 ? 'cash' : null,
      paymentTotals.card > 0 ? 'card' : null,
      paymentTotals.transfer > 0 ? 'transfer' : null,
    ].filter(Boolean)
    const paymentMethod = usedPaymentMethods.length > 1 ? 'mixed' : String(usedPaymentMethods[0] ?? 'cash')
    const cashAmount = paymentTotals.cash
    const cardAmount = paymentTotals.card
    const transferAmount = paymentTotals.transfer
    const discount = Math.max(0, Math.round(Number(order.discount_amount ?? payload.discount ?? 0)))
    const total = Math.max(0, subtotal - discount)
    if (total !== amountDue) {
      throw new AppError('SYNC_ORDER_TOTAL_CONFLICT', 'Сума позицій замовлення змінилася. Оновіть заказ і повторіть оплату.', 409)
    }
    const completedAt = payload.completed_at ?? operation.created_at
    const appliedAt = operation.applied_at ?? operation.created_at
    const managerId = uuidOr(payload.manager_id ?? order.manager_id ?? payload.cashier_id, userId)
    const customerId = isUuid(order.customer_id) ? order.customer_id : null

    await client.query(
      `INSERT INTO sales (
        id, tenant_id, sale_number, customer_id, cashier_id, shift_id, status,
        subtotal, discount, total, payment_method, is_debt, notes, manager_id,
        cash_amount, card_amount, transfer_amount, is_fiscal, completed_at, created_at, updated_at, pickup_cell
      ) VALUES (
        $1, $2, $3, $4, $5, $6, 'completed',
        $7, $8, $9, $10, false, $11, $12,
        $13, $14, $15, $16, $17, $17, $18, $19
      )`,
      [
        saleId,
        tenantId,
        saleNumber,
        customerId,
        cashierId,
        shiftId,
        subtotal,
        discount,
        total,
        paymentMethod,
        payload.notes ?? `Видача замовлення #${order.order_number ?? String(orderId).slice(0, 8)}`,
        managerId,
        cashAmount,
        cardAmount,
        transferAmount,
        payload.is_fiscal === true,
        completedAt,
        appliedAt,
        payload.pickup_cell ?? order.pickup_cell ?? null,
      ],
    )

    for (const item of items) {
      await client.query(
        `INSERT INTO sale_items (
          id, tenant_id, sale_id, product_id, qty, unit_price, discount, total,
          cost_price, core_deposit_amount, core_return_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          item.id,
          tenantId,
          saleId,
          item.product_id,
          item.qty,
          item.unit_price,
          item.discount,
          item.total,
          item.purchase_price,
          item.core_deposit_amount,
          item.core_return_status,
        ],
      )
      if (!item.is_service) {
        await client.query(
          'UPDATE products SET qty_on_hand = qty_on_hand - $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
          [item.qty, appliedAt, item.product_id, tenantId],
        )
      }
    }

    await client.query(
      'UPDATE inventory_reserves SET released_at = COALESCE(released_at, $2) WHERE order_id = $1 AND tenant_id = $3 AND released_at IS NULL',
      [orderId, appliedAt, tenantId],
    )
    await client.query(
      `UPDATE customer_order_items AS item
       SET item_status = 'handed'
       FROM customer_orders AS parent
       WHERE item.order_id = $1
         AND parent.id = item.order_id
         AND parent.tenant_id = $2
         AND item.item_status NOT IN ('canceled', 'handed')`,
      [orderId, tenantId],
    )
    await client.query(
      `UPDATE customer_orders
       SET status = 'completed', sale_id = $3, updated_at = $4
       WHERE id = $1 AND tenant_id = $2`,
      [orderId, tenantId, saleId, appliedAt],
    )
    await client.query(
      `INSERT INTO order_activity_log (order_id, user_id, action, details, created_at)
       VALUES ($1, $2, 'completed', $3, $4)`,
      [
        orderId,
        cashierId,
        { method: paymentMethod, offline: true, shift_id: shiftId, sale_id: saleId },
        appliedAt,
      ],
    )
  })
}
