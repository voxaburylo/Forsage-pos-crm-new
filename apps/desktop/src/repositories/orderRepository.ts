import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'
import { LocalPosRepository } from './posRepository'

function nowIso(): string { return new Date().toISOString() }
function num(value: unknown): number { const n = Number(value ?? 0); return Number.isFinite(n) ? n : 0 }
function boolInt(value: unknown): number { return value === true || value === 1 ? 1 : 0 }
function parseJson(value: string | null): any { if (!value) return null; try { return JSON.parse(value) } catch { return null } }

const ACTIVE_STATUSES = ['lead', 'quoted', 'new', 'in_progress', 'ordered', 'arrived', 'called', 'no_answer', 'ready']
const NON_ISSUEABLE = new Set(['lead', 'quoted', 'completed', 'canceled', 'archived'])

type PaymentMethod = 'cash' | 'card' | 'transfer' | 'account'

export class LocalOrderRepository {
  private readonly pos: LocalPosRepository

  constructor(private readonly db: LocalDatabase) {
    this.pos = new LocalPosRepository(db)
  }

  listReadyOrders(input: { tenant_id?: string; search?: string; limit?: number } = {}): any[] {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const search = String(input.search ?? '').trim().toLowerCase()
    const limit = Math.max(1, Math.min(200, input.limit ?? 80))
    const statusPlaceholders = ACTIVE_STATUSES.map(() => '?').join(',')
    const params: any[] = [tenantId, ...ACTIVE_STATUSES]
    let where = `o.tenant_id = ? AND o.deleted_at IS NULL AND o.status IN (${statusPlaceholders})`
    if (search) {
      where += ` AND (
        CAST(o.order_number AS TEXT) LIKE ?
        OR lower(COALESCE(o.kp_number, '')) LIKE ?
        OR lower(COALESCE(c.phone, '')) LIKE ?
        OR lower(COALESCE(c.full_name, '')) LIKE ?
        OR lower(COALESCE(c.card_barcode, '')) LIKE ?
      )`
      const q = `%${search}%`
      params.push(q, q, q, q, q)
    }
    params.push(limit)

    const rows = this.db.prepare(`
      SELECT o.*, c.id AS customer_id_join, c.phone AS customer_phone,
             c.full_name AS customer_full_name, c.card_barcode AS customer_card_barcode
      FROM customer_orders o
      LEFT JOIN customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
      WHERE ${where}
      ORDER BY CASE o.status WHEN 'ready' THEN 0 WHEN 'arrived' THEN 1 ELSE 2 END,
               o.updated_at DESC
      LIMIT ?
    `).all(...params) as any[]
    return rows.map((row) => this.decorateOrder(row, tenantId))
  }

  getOrder(id: string, tenantId = DEFAULT_TENANT_ID): any | null {
    const row = this.db.prepare(`
      SELECT o.*, c.id AS customer_id_join, c.phone AS customer_phone,
             c.full_name AS customer_full_name, c.card_barcode AS customer_card_barcode
      FROM customer_orders o
      LEFT JOIN customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ? AND o.deleted_at IS NULL
      LIMIT 1
    `).get(id, tenantId) as any | undefined
    return row ? this.decorateOrder(row, tenantId) : null
  }

  listPayments(orderId: string, tenantId = DEFAULT_TENANT_ID): any[] {
    return this.db.prepare(`
      SELECT * FROM order_payments
      WHERE tenant_id = ? AND order_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC
    `).all(tenantId, orderId) as any[]
  }

  addPayment(orderId: string, input: {
    tenant_id?: string
    user_id?: string | null
    amount: number
    method: PaymentMethod
    is_fiscal?: boolean
    shift_id?: string | null
    notes?: string | null
  }): { data: any; order: any } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const amount = Math.round(num(input.amount))
    if (amount <= 0) throw new Error('Некоректна сума')
    const order = this.getOrder(orderId, tenantId)
    if (!order) throw new Error('Замовлення не знайдено')
    if (order.status === 'completed') throw new Error('Замовлення вже видане')
    const remaining = this.remainingDue(order)
    const canAcceptOpenDraftDeposit = ['lead', 'quoted'].includes(order.status) && remaining <= 0
    if (!canAcceptOpenDraftDeposit && amount > remaining) throw new Error('Сума перевищує залишок до сплати')
    if (input.method === 'account' && !order.customer_id) throw new Error('Замовлення без клієнта — оплата з рахунку неможлива')

    const timestamp = nowIso()
    const paymentId = randomUUID()
    const accountTransactionId = input.method === 'account' ? randomUUID() : null
    const nextPaid = num(order.total_paid ?? order.prepayment) + amount
    const nextStatus = (order.status === 'lead' || order.status === 'quoted') && nextPaid > 0 ? 'new' : order.status

    this.db.transaction(() => {
      if (input.method === 'account') {
        const customer = this.db.prepare(`
          SELECT id, COALESCE(deposit_balance, 0) AS deposit_balance
          FROM customers
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
          LIMIT 1
        `).get(order.customer_id, tenantId) as { id: string; deposit_balance: number } | undefined
        if (!customer) throw new Error('Клієнта не знайдено')
        if (Number(customer.deposit_balance ?? 0) < amount) throw new Error('Недостатньо коштів на рахунку клієнта')
        const balanceAfter = Number(customer.deposit_balance ?? 0) - amount
        this.db.prepare(`
          UPDATE customers
          SET deposit_balance = ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(balanceAfter, timestamp, timestamp, customer.id, tenantId)
        this.db.prepare(`
          INSERT INTO customer_deposit_transactions (
            id, tenant_id, customer_id, amount, balance_after, method, order_id,
            notes, created_by, dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'account', ?, ?, ?, ?, ?, ?)
        `).run(
          accountTransactionId,
          tenantId,
          customer.id,
          -amount,
          balanceAfter,
          orderId,
          input.notes ?? `Оплата замовлення #${order.order_number ?? order.id.slice(0, 8)}`,
          input.user_id ?? null,
          timestamp,
          timestamp,
          timestamp,
        )
      }

      this.db.prepare(`
        INSERT INTO order_payments (
          id, tenant_id, order_id, amount, method, is_fiscal, shift_id, created_by,
          notes, dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(paymentId, tenantId, orderId, amount, input.method, boolInt(input.is_fiscal), input.shift_id ?? null, input.user_id ?? null, input.notes ?? null, timestamp, timestamp, timestamp)

      this.db.prepare(`
        UPDATE customer_orders
        SET total_paid = ?, status = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(nextPaid, nextStatus, timestamp, timestamp, orderId, tenantId)

      if (input.method === 'cash' && input.shift_id) {
        this.db.prepare(`
          INSERT INTO cash_operations (
            id, tenant_id, shift_id, user_id, type, source, amount, notes,
            dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'cash_in', 'cashbox', ?, ?, ?, ?, ?)
        `).run(randomUUID(), tenantId, input.shift_id, input.user_id ?? null, amount, input.notes ?? `Передоплата замовлення #${order.order_number ?? order.id.slice(0, 8)}`, timestamp, timestamp, timestamp)
      }

      this.addOutbox(tenantId, 'customer_order', orderId, 'order.payment_added', {
        order_id: orderId,
        payment_id: paymentId,
        amount,
        method: input.method,
        is_fiscal: input.is_fiscal === true,
        shift_id: input.shift_id ?? null,
        notes: input.notes ?? null,
        created_by: input.user_id ?? null,
        created_at: timestamp,
        customer_id: order.customer_id ?? null,
        account_transaction_id: accountTransactionId,
      }, timestamp)
    })

    return { data: this.listPayments(orderId, tenantId).find((p) => p.id === paymentId), order: this.getOrder(orderId, tenantId) }
  }

  completeOrder(orderId: string, input: {
    tenant_id?: string
    user_id?: string | null
    shift_id?: string | null
    payment_method?: 'cash' | 'card' | 'mixed'
    is_fiscal?: boolean
  } = {}): { data: { success: true; sale_id: string | null } } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const order = this.getOrder(orderId, tenantId)
    if (!order) throw new Error('Замовлення не знайдено')
    if (order.status === 'completed') throw new Error('Замовлення вже видане')
    if (NON_ISSUEABLE.has(order.status)) throw new Error('Чернетку або скасоване замовлення не можна видати через касу')
    const remaining = this.remainingDue(order)
    if (remaining > 0) throw new Error('Не всі оплати проведено')
    const cashierId = input.user_id ?? order.manager_id ?? 'local'
    const shiftId = input.shift_id ?? this.pos.findOpenShift(cashierId, tenantId)
    if (!shiftId) throw new Error('Спочатку відкрийте касову зміну')
    const timestamp = nowIso()

    const stockItems = order.items
      .filter((item: any) => item.item_status !== 'canceled' && item.product_id)
      .map((item: any) => ({ product_id: item.product_id, qty: num(item.qty), buy_price: num(item.buy_price), name: item.name }))
      .filter((item: any) => item.qty > 0)

    const saleId: string | null = null
    this.db.transaction(() => {
      for (const item of stockItems) {
        const product = this.db.prepare(`
          SELECT id, qty_on_hand, is_service
          FROM products
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
          LIMIT 1
        `).get(item.product_id, tenantId) as { id: string; qty_on_hand: number; is_service: number } | undefined
        if (!product || product.is_service === 1) continue
        const qtyAfter = num(product.qty_on_hand) - item.qty
        this.db.prepare(`
          UPDATE products
          SET qty_on_hand = ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(qtyAfter, timestamp, timestamp, item.product_id, tenantId)
        this.db.prepare(`
          INSERT INTO inventory_movements (
            id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
            unit_cost, notes, dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'order', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), tenantId, item.product_id, orderId, -item.qty, qtyAfter, item.buy_price, `Видача замовлення #${order.order_number ?? order.id.slice(0, 8)}`, timestamp, timestamp, timestamp)
      }

      this.db.prepare(`
        UPDATE customer_order_items
        SET item_status = 'handed', dirty_at = ?, updated_at = ?
        WHERE tenant_id = ? AND order_id = ? AND deleted_at IS NULL AND item_status <> 'canceled'
      `).run(timestamp, timestamp, tenantId, orderId)

      this.db.prepare(`
        UPDATE customer_orders
        SET status = 'completed', dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(timestamp, timestamp, orderId, tenantId)

      this.addOutbox(tenantId, 'customer_order', orderId, 'order.completed', {
        order_id: orderId,
        sale_id: saleId,
        shift_id: shiftId,
        cashier_id: cashierId,
        payment_method: input.payment_method ?? 'cash',
        is_fiscal: input.is_fiscal === true,
        completed_at: timestamp,
        items: stockItems.map((item: any) => ({ product_id: item.product_id, qty: item.qty })),
      }, timestamp)
    })

    return { data: { success: true, sale_id: saleId } }
  }

  private decorateOrder(row: any, tenantId: string): any {
    const items = this.db.prepare(`
      SELECT * FROM customer_order_items
      WHERE tenant_id = ? AND order_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC
    `).all(tenantId, row.id) as any[]
    return {
      id: row.id,
      order_number: row.order_number,
      kp_number: row.kp_number,
      customer_id: row.customer_id,
      chat_id: row.chat_id,
      manager_id: row.manager_id,
      vehicle_info: parseJson(row.vehicle_info_json),
      status: row.status,
      prepayment: num(row.prepayment),
      prepayment_method: row.prepayment_method,
      prepayment_is_fiscal: row.prepayment_is_fiscal === 1,
      total_amount: num(row.total_amount),
      total_paid: num(row.total_paid),
      discount_amount: num(row.discount_amount),
      pickup_deadline_at: row.pickup_deadline_at,
      pickup_cell: row.pickup_cell,
      comment: row.comment,
      source: row.source,
      created_at: row.created_at,
      updated_at: row.updated_at,
      sent_to_telegram_at: row.sent_to_telegram_at,
      customer: row.customer_id_join ? {
        id: row.customer_id_join,
        phone: row.customer_phone,
        full_name: row.customer_full_name,
        card_barcode: row.customer_card_barcode,
      } : null,
      items: items.map((item) => ({
        id: item.id,
        order_id: item.order_id,
        name: item.name,
        sku: item.sku,
        product_id: item.product_id,
        supplier_id: item.supplier_id,
        source_type: item.source_type,
        item_type: item.item_type,
        item_status: item.item_status,
        buy_price: num(item.buy_price),
        sell_price: num(item.sell_price),
        qty: num(item.qty),
        expected_date: item.expected_date,
        core_deposit_amount: num(item.core_deposit_amount),
        core_return_status: item.core_return_status,
      })),
    }
  }

  private remainingDue(order: any): number {
    return Math.max(0, num(order.total_amount) - num(order.discount_amount) - num(order.total_paid ?? order.prepayment))
  }

  private addOutbox(tenantId: string, aggregateType: string, aggregateId: string, operationType: string, payload: unknown, timestamp: string): number | bigint {
    const result = this.db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(randomUUID(), tenantId, this.db.deviceId, aggregateType, aggregateId, operationType, JSON.stringify(payload), timestamp)
    return result.lastInsertRowid
  }
}