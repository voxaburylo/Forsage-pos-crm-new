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
  credited_amount: number
  customer_balance: number | null
  replayed: boolean
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Cancels an order and moves any collected payment to the customer's single
 * account balance. The original payment rows stay immutable. The deposit
 * transaction deliberately uses the order id as its idempotency key, so a web
 * request, a desktop outbox replay and a repeated click cannot credit it twice.
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
      const creditResult = await client.query(
        `SELECT amount, balance_after
         FROM customer_deposit_transactions
         WHERE id = $1 AND tenant_id = $2
         LIMIT 1`,
        [input.order_id, input.tenant_id],
      )
      return {
        order_before: order,
        order_after: order,
        paid_amount: paidAmount,
        credited_amount: numeric(creditResult.rows[0]?.amount),
        customer_balance: creditResult.rowCount ? numeric(creditResult.rows[0]?.balance_after) : null,
        replayed: true,
      }
    }
    if (paidAmount > 0 && input.refund_prepayment) {
      throw new AppError(
        'FINANCIAL_CANCEL_IN_POS_ONLY',
        'Менеджер скасовує замовлення із зарахуванням оплати на рахунок клієнта. Фактичну видачу грошей потім проводить касир.',
        409,
      )
    }

    let customerBalance: number | null = null
    let creditedAmount = 0
    if (paidAmount > 0) {
      const customerId = String(order.customer_id ?? '')
      if (!customerId) {
        throw new AppError(
          'ORDER_CUSTOMER_REQUIRED_FOR_CREDIT',
          'До оплаченого замовлення не прив’язаний клієнт. Спочатку виберіть клієнта в замовленні.',
          422,
        )
      }
      const existingCredit = await client.query(
        `SELECT amount, balance_after
         FROM customer_deposit_transactions
         WHERE id = $1 AND tenant_id = $2
         LIMIT 1`,
        [input.order_id, input.tenant_id],
      )
      if (existingCredit.rowCount) {
        creditedAmount = numeric(existingCredit.rows[0].amount)
        customerBalance = numeric(existingCredit.rows[0].balance_after)
      } else {
        const customerResult = await client.query(
          `SELECT id, COALESCE(deposit_balance, 0) AS deposit_balance
           FROM customers
           WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
           LIMIT 1 FOR UPDATE`,
          [customerId, input.tenant_id],
        )
        if (!customerResult.rowCount) {
          throw new AppError('ORDER_CUSTOMER_NOT_FOUND', 'Клієнта замовлення не знайдено', 404)
        }
        customerBalance = numeric(customerResult.rows[0].deposit_balance) + paidAmount
        await client.query(
          `UPDATE customers
           SET deposit_balance = $3, updated_at = $4
           WHERE id = $1 AND tenant_id = $2`,
          [customerId, input.tenant_id, customerBalance, createdAt],
        )
        await client.query(
          `INSERT INTO customer_deposit_transactions (
             id, tenant_id, customer_id, amount, balance_after, method, order_id,
             notes, created_by, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, 'account', $1, $6, $7, $8, $8)`,
          [
            input.order_id,
            input.tenant_id,
            customerId,
            paidAmount,
            customerBalance,
            `Скасування замовлення №${String(order.order_number ?? input.order_id)}`,
            input.user_id,
            createdAt,
          ],
        )
        creditedAmount = paidAmount
      }
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
          keep_as_credit: creditedAmount > 0,
          reason: input.reason ?? null,
          credited_amount: creditedAmount,
          customer_balance: customerBalance,
        }),
        createdAt,
      ],
    )

    return {
      order_before: order,
      order_after: updateResult.rows[0] as Record<string, unknown>,
      paid_amount: paidAmount,
      credited_amount: creditedAmount,
      customer_balance: customerBalance,
      replayed: false,
    }
  })
}
