import { runTransaction } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'

export type CancelOrderInput = {
  order_id: string
  tenant_id: string
  user_id: string
  refund_prepayment: boolean
  keep_as_credit: boolean
  reason?: string | null
  created_at?: string
}

export type CancelOrderResult = {
  order_before: Record<string, unknown>
  order_after: Record<string, unknown>
  paid_amount: number
  replayed: boolean
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Cancels an order without silently fabricating a refund. Financial cancellation
 * is deliberately blocked until it can be confirmed by the POS/fiscal flow for
 * each original payment method. Existing payments remain immutable ledger rows.
 */
export async function cancelOrderSafely(input: CancelOrderInput): Promise<CancelOrderResult> {
  if (input.refund_prepayment && input.keep_as_credit) {
    throw new AppError('INVALID_CANCEL_ACTION', 'Оберіть лише одну дію з оплатою', 422)
  }
  const requestedDate = input.created_at ? new Date(input.created_at) : new Date()
  if (Number.isNaN(requestedDate.getTime())) {
    throw new AppError('INVALID_CANCEL_DATE', 'Некоректна дата скасування', 422)
  }
  const createdAt = requestedDate.toISOString()

  return runTransaction(async (client) => {
    const orderResult = await client.query(
      `SELECT id, tenant_id, status, total_paid, prepayment, customer_id,
              order_number, comment
       FROM customer_orders
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [input.order_id, input.tenant_id],
    )
    if (!orderResult.rowCount) {
      throw new AppError('ORDER_NOT_FOUND', 'Замовлення не знайдено', 404)
    }
    const order = orderResult.rows[0] as Record<string, unknown>
    if (order.status === 'completed') {
      throw new AppError('ALREADY_COMPLETED', 'Завершене замовлення не можна скасувати', 400)
    }

    const paymentResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS paid_amount
       FROM order_payments
       WHERE order_id = $1 AND tenant_id = $2`,
      [input.order_id, input.tenant_id],
    )
    const paidAmount = Math.max(
      numeric(order.total_paid),
      numeric(order.prepayment),
      numeric(paymentResult.rows[0]?.paid_amount),
    )

    if (order.status === 'canceled') {
      return { order_before: order, order_after: order, paid_amount: paidAmount, replayed: true }
    }
    if (paidAmount > 0 && (input.refund_prepayment || input.keep_as_credit)) {
      throw new AppError(
        'FINANCIAL_CANCEL_IN_POS_ONLY',
        'Оплачене замовлення можна скасувати без зміни оплати. Повернення або зарахування на рахунок проведіть через касу.',
        409,
      )
    }

    const reason = String(input.reason ?? '').trim()
    const priorComment = String(order.comment ?? '').trim()
    const comment = reason
      ? `${priorComment ? `${priorComment}\n` : ''}Скасування: ${reason}`
      : priorComment || null

    const updateResult = await client.query(
      `UPDATE customer_orders
       SET status = 'canceled', comment = $3, updated_at = $4
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [input.order_id, input.tenant_id, comment, createdAt],
    )
    await client.query(
      `UPDATE inventory_reserves
       SET released_at = $3
       WHERE order_id = $1 AND tenant_id = $2 AND released_at IS NULL`,
      [input.order_id, input.tenant_id, createdAt],
    )
    await client.query(
      `UPDATE customer_order_items i
       SET item_status = 'canceled'
       FROM customer_orders o
       WHERE i.order_id = $1
         AND i.order_id = o.id
         AND o.tenant_id = $2
         AND i.item_status <> 'handed'`,
      [input.order_id, input.tenant_id],
    )
    await client.query(
      `INSERT INTO order_activity_log (order_id, user_id, action, details, created_at)
       VALUES ($1, $2, 'canceled', $3::jsonb, $4)`,
      [
        input.order_id,
        input.user_id,
        JSON.stringify({
          refund_prepayment: false,
          keep_as_credit: false,
          reason: input.reason ?? null,
          amount_preserved: paidAmount,
        }),
        createdAt,
      ],
    )

    return {
      order_before: order,
      order_after: updateResult.rows[0] as Record<string, unknown>,
      paid_amount: paidAmount,
      replayed: false,
    }
  })
}
