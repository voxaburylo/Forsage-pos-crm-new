import { randomUUID } from 'node:crypto'
import { runTransaction } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'

export type OrderPaymentMethod = 'cash' | 'card' | 'transfer' | 'account'

export type AddOrderPaymentInput = {
  payment_id?: string
  order_id: string
  tenant_id: string
  user_id: string
  amount: number
  method: OrderPaymentMethod
  is_fiscal: boolean
  shift_id?: string | null
  notes?: string | null
  created_at?: string
  accept_closed_shift?: boolean
}

export type AddOrderPaymentResult = {
  payment: Record<string, unknown>
  order_before: Record<string, unknown>
  order_after: Record<string, unknown>
  replayed: boolean
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export async function addOrderPayment(input: AddOrderPaymentInput): Promise<AddOrderPaymentResult> {
  const paymentId = input.payment_id ?? randomUUID()
  const requestedDate = input.created_at ? new Date(input.created_at) : new Date()
  if (Number.isNaN(requestedDate.getTime())) {
    throw new AppError('INVALID_PAYMENT_DATE', 'Некоректна дата платежу', 422)
  }
  const createdAt = requestedDate.toISOString()

  return runTransaction(async (client) => {
    // The order lock serializes simultaneous payments. The idempotency check is
    // deliberately after it, so a concurrent retry sees the first committed row.
    const orderResult = await client.query(
      `SELECT id, tenant_id, status, total_amount, discount_amount, total_paid,
              prepayment, customer_id, order_number
       FROM customer_orders
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [input.order_id, input.tenant_id],
    )
    if (!orderResult.rowCount) {
      throw new AppError('ORDER_NOT_FOUND', 'Замовлення не знайдено', 404)
    }
    const order = orderResult.rows[0] as Record<string, unknown>

    const existingResult = await client.query(
      'SELECT * FROM order_payments WHERE id = $1 LIMIT 1',
      [paymentId],
    )
    if (existingResult.rowCount) {
      const existing = existingResult.rows[0] as Record<string, unknown>
      const sameRequest = existing.tenant_id === input.tenant_id
        && existing.order_id === input.order_id
        && numeric(existing.amount) === input.amount
        && existing.method === input.method
      if (!sameRequest) {
        throw new AppError(
          'PAYMENT_ID_REUSED',
          'Цей ідентифікатор платежу вже використано для іншої оплати',
          409,
        )
      }
      return {
        payment: existing,
        order_before: order,
        order_after: order,
        replayed: true,
      }
    }

    if (order.status === 'completed') {
      throw new AppError('ALREADY_COMPLETED', 'Замовлення вже завершено', 400)
    }
    if (order.status === 'canceled' || order.status === 'archived') {
      throw new AppError('PAYMENT_NOT_ALLOWED', 'Для скасованого або архівного замовлення оплату приймати не можна', 400)
    }

    const totalPaid = numeric(order.total_paid ?? order.prepayment)
    const payable = Math.max(0, numeric(order.total_amount) - numeric(order.discount_amount))
    const remaining = payable - totalPaid
    const canAcceptOpenDraftDeposit = ['lead', 'quoted'].includes(String(order.status)) && remaining <= 0
    if (!canAcceptOpenDraftDeposit && input.amount > remaining) {
      throw new AppError('OVERPAYMENT', 'Сума перевищує залишок до сплати', 400)
    }

    let shiftResult
    if (input.shift_id && input.accept_closed_shift) {
      shiftResult = await client.query(
        `SELECT id FROM shifts
         WHERE id = $1 AND tenant_id = $2
           AND opened_at <= $3
           AND (closed_at IS NULL OR closed_at >= $3)
         FOR SHARE`,
        [input.shift_id, input.tenant_id, createdAt],
      )
    } else if (input.shift_id) {
      shiftResult = await client.query(
        `SELECT id FROM shifts
         WHERE id = $1 AND tenant_id = $2 AND status = 'open'
         FOR SHARE`,
        [input.shift_id, input.tenant_id],
      )
    } else {
      shiftResult = await client.query(
        `SELECT id FROM shifts
         WHERE tenant_id = $1 AND cashier_id = $2 AND status = 'open'
         ORDER BY opened_at DESC
         LIMIT 1
         FOR SHARE`,
        [input.tenant_id, input.user_id],
      )
    }
    if (!shiftResult.rowCount) {
      throw new AppError('OPEN_SHIFT_REQUIRED', 'Спочатку відкрийте касову зміну', 400)
    }
    const shiftId = String(shiftResult.rows[0].id)
    const paymentNote = input.notes ?? null

    if (input.method === 'account') {
      if (!order.customer_id) {
        throw new AppError('NO_CUSTOMER', 'Замовлення без клієнта — оплата з рахунку неможлива', 400)
      }
      const customerResult = await client.query(
        `SELECT id, COALESCE(deposit_balance, 0) AS deposit_balance
         FROM customers
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [order.customer_id, input.tenant_id],
      )
      if (!customerResult.rowCount) {
        throw new AppError('CUSTOMER_NOT_FOUND', 'Клієнта не знайдено', 404)
      }
      const balanceAfter = numeric(customerResult.rows[0].deposit_balance) - input.amount
      if (balanceAfter < 0) {
        throw new AppError('INSUFFICIENT_DEPOSIT', 'Недостатньо коштів на рахунку клієнта', 400)
      }
      await client.query(
        `UPDATE customers
         SET deposit_balance = $3, updated_at = $4
         WHERE id = $1 AND tenant_id = $2`,
        [order.customer_id, input.tenant_id, balanceAfter, createdAt],
      )
      await client.query(
        `INSERT INTO customer_deposit_transactions (
           id, tenant_id, customer_id, amount, balance_after, method, order_id,
           shift_id, notes, created_by, created_at
         ) VALUES ($1, $2, $3, $4, $5, 'account', $6, $7, $8, $9, $10)`,
        [
          paymentId,
          input.tenant_id,
          order.customer_id,
          -input.amount,
          balanceAfter,
          input.order_id,
          shiftId,
          paymentNote ?? `Оплата замовлення #${order.order_number ?? input.order_id.slice(0, 8)}`,
          input.user_id,
          createdAt,
        ],
      )
    }

    const paymentResult = await client.query(
      `INSERT INTO order_payments (
         id, tenant_id, order_id, amount, method, is_fiscal, shift_id,
         created_by, notes, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        paymentId,
        input.tenant_id,
        input.order_id,
        input.amount,
        input.method,
        input.method === 'account' ? false : input.is_fiscal,
        shiftId,
        input.user_id,
        paymentNote,
        createdAt,
      ],
    )

    const newTotalPaid = totalPaid + input.amount
    const updatedStatus = ['lead', 'quoted'].includes(String(order.status)) && newTotalPaid > 0
      ? 'new'
      : String(order.status)
    await client.query(
      `UPDATE customer_orders
       SET total_paid = $3, status = $4, updated_at = $5
       WHERE id = $1 AND tenant_id = $2`,
      [input.order_id, input.tenant_id, newTotalPaid, updatedStatus, createdAt],
    )

    if (updatedStatus === 'new' && ['lead', 'quoted'].includes(String(order.status))) {
      await client.query('SELECT reserve_order_items($1, $2, $3)', [
        input.tenant_id,
        input.order_id,
        input.user_id,
      ])
    }

    if (input.method === 'cash') {
      await client.query(
        `INSERT INTO cash_operations (
           id, tenant_id, shift_id, type, amount, note, source, created_by, created_at
         ) VALUES ($1, $2, $3, 'in', $4, $5, 'cashbox', $6, $7)`,
        [
          paymentId,
          input.tenant_id,
          shiftId,
          input.amount,
          paymentNote ?? `${canAcceptOpenDraftDeposit ? 'Передоплата' : 'Оплата'} замовлення #${order.order_number ?? input.order_id.slice(0, 8)}`,
          input.user_id,
          createdAt,
        ],
      )
    }

    const remainingAfter = Math.max(0, payable - newTotalPaid)
    await client.query(
      `INSERT INTO order_activity_log (order_id, user_id, action, details, created_at)
       VALUES ($1, $2, 'payment_added', $3::jsonb, $4)`,
      [
        input.order_id,
        input.user_id,
        JSON.stringify({ amount: input.amount, method: input.method, remaining: remainingAfter }),
        createdAt,
      ],
    )

    return {
      payment: paymentResult.rows[0] as Record<string, unknown>,
      order_before: order,
      order_after: { ...order, total_paid: newTotalPaid, status: updatedStatus, updated_at: createdAt },
      replayed: false,
    }
  })
}
