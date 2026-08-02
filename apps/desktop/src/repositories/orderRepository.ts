import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'
import { LocalPosRepository } from './posRepository'

function nowIso(): string { return new Date().toISOString() }
function dayStamp(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
}
function num(value: unknown): number { const n = Number(value ?? 0); return Number.isFinite(n) ? n : 0 }
function boolInt(value: unknown): number { return value === true || value === 1 ? 1 : 0 }
function parseJson(value: string | null): any { if (!value) return null; try { return JSON.parse(value) } catch { return null } }

const ACTIVE_STATUSES = ['lead', 'quoted', 'new', 'in_progress', 'ordered', 'arrived', 'called', 'no_answer', 'ready']
const NON_ISSUEABLE = new Set(['canceled', 'archived'])
const TERMINAL_STATUSES = new Set(['completed', 'canceled', 'archived'])
const MANUAL_ORDER_STATUSES = new Set(['lead', 'quoted', 'new', 'in_progress', 'ordered', 'arrived', 'called', 'no_answer', 'ready'])
const MANUAL_ITEM_STATUSES = new Set(['pending', 'ordered', 'arrived', 'canceled'])
const ORDER_STATUS_TRANSITIONS: Record<string, string[]> = {
  lead: ['new', 'in_progress', 'ordered'],
  quoted: ['new', 'in_progress', 'ordered'],
  new: ['in_progress', 'ordered'],
  in_progress: ['new', 'ordered'],
  ordered: ['new'],
  arrived: ['called', 'no_answer'],
  ready: ['called', 'no_answer'],
  called: ['no_answer', 'ready'],
  no_answer: ['called', 'ready'],
}

function canChangeOrderStatus(from: string, to: string): boolean {
  return from === to || (ORDER_STATUS_TRANSITIONS[from] ?? []).includes(to)
}

type LocalOrderItemState = { item_status: string; sell_price: number; qty: number; core_deposit_amount: number }


type PaymentMethod = 'cash' | 'card' | 'transfer' | 'account'

export class LocalOrderRepository {
  private readonly pos: LocalPosRepository

  constructor(private readonly db: LocalDatabase) {
    this.pos = new LocalPosRepository(db)
  }

  listOrders(input: { tenant_id?: string; offset?: number; limit?: number; search?: string; status?: string } = {}): any[] {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const offset = Math.max(0, Number(input.offset ?? 0) || 0)
    const limit = Math.max(1, Math.min(500, Number(input.limit ?? 200) || 200))
    const raw = String(input.search ?? '').trim()
    const params: any[] = [tenantId]
    let searchSql = ''
    const statuses = String(input.status ?? '').split(',').map((status) => status.trim()).filter(Boolean)
    let statusSql = ''
    if (statuses.length > 0) {
      statusSql = ` AND o.status IN (${statuses.map(() => '?').join(',')})`
      params.push(...statuses)
    }

    if (raw) {
      const q = `%${raw}%`
      searchSql = ` AND (
        CAST(o.order_number AS TEXT) LIKE ?
        OR COALESCE(o.kp_number, '') LIKE ?
        OR COALESCE(c.phone, '') LIKE ?
        OR COALESCE(c.full_name, '') LIKE ?
        OR COALESCE(c.card_barcode, '') LIKE ?
        OR EXISTS (
          SELECT 1 FROM customer_order_items i
          WHERE i.order_id = o.id AND i.deleted_at IS NULL
            AND (lower(COALESCE(i.name, '')) LIKE lower(?) OR lower(COALESCE(i.sku, '')) LIKE lower(?))
        )
      )`
      params.push(q, q, q, q, q, q, q)
    }
    params.push(limit, offset)
    const rows = this.db.prepare(`
      SELECT o.*, c.id AS customer_id_join, c.phone AS customer_phone,
             c.full_name AS customer_full_name, c.card_barcode AS customer_card_barcode
      FROM customer_orders o
      LEFT JOIN customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
      WHERE o.tenant_id = ? AND o.deleted_at IS NULL ${statusSql} ${searchSql}
      ORDER BY o.updated_at DESC, o.id DESC
      LIMIT ? OFFSET ?
    `).all(...params) as any[]
    return rows.map((row) => this.decorateOrder(row, tenantId))
  }

  saveOrder(input: any, orderId?: string): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const timestamp = nowIso()
    const id = orderId ?? randomUUID()
    if (!orderId && input.exchange_source_order_id) {
      const prior = this.db.prepare(`
        SELECT id FROM customer_orders
        WHERE tenant_id = ? AND exchange_source_order_id = ? AND deleted_at IS NULL
        LIMIT 1
      `).get(tenantId, input.exchange_source_order_id) as { id: string } | undefined
      if (prior) return this.getOrder(prior.id, tenantId)
      const source = this.getOrder(input.exchange_source_order_id, tenantId)
      if (!source || source.status !== 'completed' || !source.sale_id) {
        throw new Error('Обмін можна створити тільки для виданого замовлення з чеком')
      }
    }
    const existing = orderId ? this.getOrder(orderId, tenantId) : null
    if (orderId && !existing) throw new Error('Замовлення не знайдено')
    if (existing && TERMINAL_STATUSES.has(String(existing.status))) {
      throw new Error('Завершене, скасоване або архівне замовлення не можна редагувати')
    }
    const rawItems = Array.isArray(input.items) ? input.items : existing?.items ?? []
    const items = rawItems.map((item: any) => {
      const product = item.product_id ? this.db.prepare(`
        SELECT requires_core_return, core_deposit_amount
        FROM products
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        LIMIT 1
      `).get(item.product_id, tenantId) as {
        requires_core_return: number
        core_deposit_amount: number
      } | undefined : undefined
      const itemStatus = String(item.item_status ?? 'pending')
      if (!MANUAL_ITEM_STATUSES.has(itemStatus)) {
        throw new Error('Видача або повернення позиції виконується тільки через касу')
      }
      const savedCoreDeposit = Math.max(0, Math.round(num(item.core_deposit_amount)))
      const coreDepositAmount = savedCoreDeposit > 0
        ? savedCoreDeposit
        : product?.requires_core_return === 1
          ? Math.max(0, Math.round(num(product.core_deposit_amount)))
          : 0
      return {
        ...item,
        item_status: itemStatus,
        core_deposit_amount: coreDepositAmount,
        core_return_status: item.core_return_status
          ?? (coreDepositAmount > 0 ? 'pending' : 'none'),
      }
    })
    const totalAmount = items.reduce((sum: number, item: any) => {
      const qty = num(item.qty)
      return sum
        + Math.round(num(item.sell_price) * qty)
        + Math.round(num(item.core_deposit_amount) * qty)
    }, 0)
    const orderNumber = existing?.order_number ?? this.nextOrderNumber(tenantId, timestamp)
    const status = existing?.status ?? 'lead'
    // Payment totals are a ledger projection and may only be changed by POS operations.
    const totalPaid = existing?.total_paid ?? 0
    const prepayment = existing?.prepayment ?? 0

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO customer_orders (
          id, tenant_id, order_number, kp_number, customer_id, chat_id, manager_id,
          vehicle_info_json, status, prepayment, prepayment_method,
          prepayment_is_fiscal, total_amount, total_paid, discount_amount,
          pickup_deadline_at, pickup_cell, comment, source, exchange_source_order_id, dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          customer_id = excluded.customer_id,
          chat_id = excluded.chat_id,
          vehicle_info_json = excluded.vehicle_info_json,
          prepayment = excluded.prepayment,
          prepayment_method = excluded.prepayment_method,
          prepayment_is_fiscal = excluded.prepayment_is_fiscal,
          total_amount = excluded.total_amount,
          total_paid = excluded.total_paid,
          discount_amount = excluded.discount_amount,
          pickup_deadline_at = excluded.pickup_deadline_at,
          pickup_cell = excluded.pickup_cell,
          comment = excluded.comment,
          source = excluded.source,
          dirty_at = excluded.dirty_at,
          updated_at = excluded.updated_at,
          deleted_at = NULL
      `).run(
        id, tenantId, orderNumber, existing?.kp_number ?? null,
        input.customer_id !== undefined ? input.customer_id : existing?.customer_id ?? null,
        input.chat_id !== undefined ? input.chat_id : existing?.chat_id ?? null,
        input.manager_id ?? existing?.manager_id ?? 'local',
        JSON.stringify(input.vehicle_info !== undefined ? input.vehicle_info : existing?.vehicle_info ?? null),
        status, prepayment,
        input.prepayment_method !== undefined ? input.prepayment_method : existing?.prepayment_method ?? null,
        input.prepayment_is_fiscal === true ? 1 : existing?.prepayment_is_fiscal ? 1 : 0,
        totalAmount, totalPaid, existing?.discount_amount ?? 0,
        input.pickup_deadline_at ?? existing?.pickup_deadline_at ?? null,
        input.pickup_cell ?? existing?.pickup_cell ?? null,
        input.comment !== undefined ? input.comment : existing?.comment ?? null,
        input.source ?? existing?.source ?? 'walk_in',
        input.exchange_source_order_id ?? existing?.exchange_source_order_id ?? null,
        timestamp, existing?.created_at ?? timestamp, timestamp,
      )

      const incomingIds = new Set<string>()
      for (const item of items) {
        const itemId = item.id ?? randomUUID()
        incomingIds.add(itemId)
        this.db.prepare(`
          INSERT INTO customer_order_items (
            id, tenant_id, order_id, name, sku, product_id, supplier_id,
            source_type, item_type, item_status, buy_price, sell_price, qty,
            expected_date, core_deposit_amount, core_return_status,
            dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name, sku = excluded.sku, product_id = excluded.product_id,
            supplier_id = excluded.supplier_id, source_type = excluded.source_type,
            item_type = excluded.item_type, item_status = excluded.item_status,
            buy_price = excluded.buy_price, sell_price = excluded.sell_price,
            qty = excluded.qty, expected_date = excluded.expected_date,
            core_deposit_amount = excluded.core_deposit_amount,
            core_return_status = excluded.core_return_status,
            dirty_at = excluded.dirty_at, updated_at = excluded.updated_at, deleted_at = NULL
        `).run(
          itemId, tenantId, id, item.name, item.sku ?? null, item.product_id ?? null,
          item.supplier_id ?? null, item.source_type ?? 'warehouse', item.item_type ?? 'product',
          item.item_status ?? 'pending', num(item.buy_price), num(item.sell_price),
          num(item.qty) || 1, item.expected_date ?? null,
          item.core_deposit_amount, item.core_return_status, timestamp,
          item.created_at ?? timestamp, timestamp,
        )
      }
      if (orderId) {
        const currentItems = this.db.prepare(`
          SELECT id FROM customer_order_items
          WHERE tenant_id = ? AND order_id = ? AND deleted_at IS NULL
        `).all(tenantId, id) as Array<{ id: string }>
        for (const current of currentItems) {
          if (!incomingIds.has(current.id)) {
            this.db.prepare(`
              UPDATE customer_order_items SET deleted_at = ?, dirty_at = ?, updated_at = ?
              WHERE id = ? AND tenant_id = ?
            `).run(timestamp, timestamp, timestamp, current.id, tenantId)
          }
        }
      }

      const syncPayload = this.getOrder(id, tenantId)
      this.addOutbox(
        tenantId,
        'customer_order',
        id,
        orderId ? 'order.updated' : 'order.created',
        syncPayload ?? { id, ...input, order_number: orderNumber, total_amount: totalAmount },
        timestamp,
      )
    })
    return this.getOrder(id, tenantId)
  }

  deleteOrder(orderId: string, tenantId = DEFAULT_TENANT_ID): { success: true } {
    const timestamp = nowIso()
    const order = this.getOrder(orderId, tenantId)
    if (!order) throw new Error('Замовлення не знайдено')
    const ledger = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS paid
      FROM order_payments
      WHERE tenant_id = ? AND order_id = ? AND deleted_at IS NULL
    `).get(tenantId, orderId) as { count: number; paid: number } | undefined
    if (!['lead', 'quoted', 'new'].includes(String(order.status))
      || num(order.prepayment) !== 0
      || num(order.total_paid) !== 0
      || num(ledger?.count) > 0
      || num(ledger?.paid) !== 0
      || order.sale_id) {
      throw new Error('Видалити можна лише неоплачений чернетковий заказ. Інший заказ можна скасувати або архівувати.')
    }
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE customer_orders SET deleted_at = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(timestamp, timestamp, timestamp, orderId, tenantId)
      this.db.prepare(`
        UPDATE customer_order_items SET deleted_at = ?, dirty_at = ?, updated_at = ?
        WHERE order_id = ? AND tenant_id = ? AND deleted_at IS NULL
      `).run(timestamp, timestamp, timestamp, orderId, tenantId)
      this.db.prepare(`
        UPDATE stock_reserves SET released_at = ?, updated_at = ?
        WHERE order_id = ? AND tenant_id = ? AND released_at IS NULL AND deleted_at IS NULL
      `).run(timestamp, timestamp, orderId, tenantId)
      this.addOutbox(tenantId, 'customer_order', orderId, 'order.deleted', { id: orderId }, timestamp)
    })
    return { success: true }
  }

  updateOrderStatus(orderId: string, status: string, tenantId = DEFAULT_TENANT_ID): any {
    const timestamp = nowIso()
    const order = this.getOrder(orderId, tenantId)
    if (!order) throw new Error('Замовлення не знайдено')
    if (TERMINAL_STATUSES.has(String(order.status))) {
      throw new Error('Статус завершеного, скасованого або архівного замовлення змінювати не можна')
    }
    if (!MANUAL_ORDER_STATUSES.has(status)) {
      throw new Error('Видача та скасування замовлення виконуються тільки окремою безпечною дією в касі')
    }
    if (!canChangeOrderStatus(String(order.status), status)) {
      throw new Error('Цей перехід статусу недоступний. Готовність визначається за позиціями, а видача виконується в касі.')
    }
    this.db.prepare(`
      UPDATE customer_orders SET status = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(status, timestamp, timestamp, orderId, tenantId)
    this.addOutbox(tenantId, 'customer_order', orderId, 'order.status_updated', { id: orderId, status }, timestamp)
    return this.getOrder(orderId, tenantId)
  }

  updateOrderItemStatus(orderId: string, itemId: string, itemStatus: string, tenantId = DEFAULT_TENANT_ID): any {
    const timestamp = nowIso()
    const order = this.getOrder(orderId, tenantId)
    if (!order) throw new Error('Замовлення не знайдено')
    if (TERMINAL_STATUSES.has(String(order.status))) {
      throw new Error('Позиції завершеного, скасованого або архівного замовлення змінювати не можна')
    }
    if (!MANUAL_ITEM_STATUSES.has(itemStatus)) {
      throw new Error('Видача або повернення позиції виконується тільки через касу')
    }
    this.db.transaction(() => {
    const result = this.db.prepare(`
      UPDATE customer_order_items SET item_status = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND order_id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).run(itemStatus, timestamp, timestamp, itemId, orderId, tenantId)
    if (Number(result.changes) === 0) throw new Error('Позицію не знайдено')
    const activeItems = this.db.prepare(`
      SELECT item_status, sell_price, qty, core_deposit_amount
      FROM customer_order_items
      WHERE tenant_id = ? AND order_id = ? AND deleted_at IS NULL AND item_status <> 'canceled'
    `).all(tenantId, orderId) as LocalOrderItemState[]
    const totalAmount = activeItems.reduce((sum, item) => sum + num(item.sell_price) * num(item.qty) + num(item.core_deposit_amount) * num(item.qty), 0)
    const nextStatus = activeItems.length > 0 && activeItems.every((item) => ['arrived', 'handed', 'returned'].includes(item.item_status))
      ? 'ready'
      : activeItems.some((item) => item.item_status === 'ordered')
        ? 'ordered'
        : 'new'
    this.db.prepare(`
      UPDATE customer_orders SET total_amount = ?, status = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(totalAmount, nextStatus, timestamp, timestamp, orderId, tenantId)
    if (itemStatus === 'canceled') {
      this.db.prepare(`
        UPDATE stock_reserves SET released_at = ?, dirty_at = ?, updated_at = ?
        WHERE tenant_id = ? AND order_id = ? AND product_id = (
          SELECT product_id FROM customer_order_items WHERE id = ? AND tenant_id = ?
        ) AND released_at IS NULL AND deleted_at IS NULL
      `).run(timestamp, timestamp, timestamp, tenantId, orderId, itemId, tenantId)
    }
    this.addOutbox(tenantId, 'customer_order', orderId, 'order.item_status_updated', {
      order_id: orderId, item_id: itemId, item_status: itemStatus,
    }, timestamp)
    })
    return this.getOrder(orderId, tenantId)
  }

  cancelOrder(orderId: string, input: { refund_prepayment?: boolean; keep_as_credit?: boolean; reason?: string | null; tenant_id?: string } = {}): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const order = this.getOrder(orderId, tenantId)
    if (!order) throw new Error('Замовлення не знайдено')
    if (order.status === 'completed') throw new Error('Завершене замовлення не можна скасувати')
    if (order.status === 'canceled') return order

    const ledger = this.db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS paid
      FROM order_payments
      WHERE tenant_id = ? AND order_id = ? AND deleted_at IS NULL
    `).get(tenantId, orderId) as { paid: number } | undefined
    const paid = Math.max(num(order.total_paid), num(order.prepayment), num(ledger?.paid))
    if (paid > 0 && (input.refund_prepayment || input.keep_as_credit)) {
      throw new Error('Оплачене замовлення можна скасувати без зміни оплати. Повернення або зарахування на рахунок проведіть через касу.')
    }

    const timestamp = nowIso()
    const reason = String(input.reason ?? '').trim()
    const priorComment = String(order.comment ?? '').trim()
    const comment = reason ? `${priorComment ? `${priorComment}\n` : ''}Скасування: ${reason}` : priorComment || null
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE customer_orders
        SET status = 'canceled', comment = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(comment, timestamp, timestamp, orderId, tenantId)
      this.db.prepare(`
        UPDATE customer_order_items
        SET item_status = 'canceled', dirty_at = ?, updated_at = ?
        WHERE order_id = ? AND tenant_id = ? AND item_status <> 'handed' AND deleted_at IS NULL
      `).run(timestamp, timestamp, orderId, tenantId)
      this.db.prepare(`
        UPDATE stock_reserves
        SET released_at = ?, dirty_at = ?, updated_at = ?
        WHERE order_id = ? AND tenant_id = ? AND released_at IS NULL AND deleted_at IS NULL
      `).run(timestamp, timestamp, timestamp, orderId, tenantId)
      this.addOutbox(tenantId, 'customer_order', orderId, 'order.canceled', {
        id: orderId,
        refund_prepayment: false,
        keep_as_credit: false,
        reason: input.reason ?? null,
        paid_amount_preserved: paid,
      }, timestamp)
    })
    return this.getOrder(orderId, tenantId)
  }
  listPendingItems(supplierId: string, tenantId = DEFAULT_TENANT_ID): any[] {
    return this.db.prepare(`
      SELECT i.*, o.order_number, o.customer_id
      FROM customer_order_items i
      JOIN customer_orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
      WHERE i.tenant_id = ? AND i.supplier_id = ? AND i.deleted_at IS NULL
        AND o.deleted_at IS NULL AND i.item_status IN ('pending', 'ordered')
      ORDER BY o.created_at ASC
    `).all(tenantId, supplierId) as any[]
  }

  bulkArrival(itemIds: string[], tenantId = DEFAULT_TENANT_ID): { updated: number } {
    const uniqueIds = [...new Set(itemIds)]
    if (uniqueIds.length === 0) throw new Error('Оберіть хоча б одну позицію')
    const placeholders = uniqueIds.map(() => '?').join(',')
    const ownedRows = this.db.prepare(`
      SELECT id FROM customer_order_items
      WHERE tenant_id = ? AND deleted_at IS NULL AND id IN (${placeholders})
    `).all(tenantId, ...uniqueIds) as Array<{ id: string }>
    if (ownedRows.length !== uniqueIds.length) {
      throw new Error('Одна або кілька позицій не знайдені у вашому магазині')
    }

    const timestamp = nowIso()
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE customer_order_items
        SET item_status = 'arrived', dirty_at = ?, updated_at = ?
        WHERE tenant_id = ? AND deleted_at IS NULL AND id IN (${placeholders})
      `).run(timestamp, timestamp, tenantId, ...uniqueIds)
      this.addOutbox(tenantId, 'customer_order', 'bulk', 'order.items_arrived', { item_ids: uniqueIds }, timestamp)
    })
    return { updated: uniqueIds.length }
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

  listPaymentsByPeriod(input: {
    tenant_id?: string
    date_from?: string
    date_to?: string
    shift_id?: string
  } = {}): any[] {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const conditions = ['p.tenant_id = ?', 'p.deleted_at IS NULL']
    const params: any[] = [tenantId]
    if (input.date_from) {
      conditions.push('p.created_at >= ?')
      params.push(input.date_from)
    }
    if (input.date_to) {
      conditions.push('p.created_at <= ?')
      params.push(input.date_to)
    }
    if (input.shift_id) {
      conditions.push('p.shift_id = ?')
      params.push(input.shift_id)
    }
    return this.db.prepare(`
      SELECT p.*
      FROM order_payments p
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.created_at ASC
    `).all(...params) as any[]
  }

  addPayment(orderId: string, input: {
    tenant_id?: string
    user_id?: string | null
    payment_id?: string
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
    const paymentId = input.payment_id ?? randomUUID()
    const existingPayment = this.db.prepare(`
      SELECT * FROM order_payments WHERE id = ? LIMIT 1
    `).get(paymentId) as any | undefined
    if (existingPayment) {
      const sameRequest = existingPayment.tenant_id === tenantId
        && existingPayment.order_id === orderId
        && num(existingPayment.amount) === amount
        && existingPayment.method === input.method
      if (!sameRequest) throw new Error('Цей ідентифікатор платежу вже використано для іншої оплати')
      return { data: existingPayment, order }
    }
    if (order.status === 'completed') throw new Error('Замовлення вже видане')
    const remaining = this.remainingDue(order)
    const canAcceptOpenDraftDeposit = ['lead', 'quoted'].includes(order.status) && remaining <= 0
    if (!canAcceptOpenDraftDeposit && amount > remaining) throw new Error('Сума перевищує залишок до сплати')
    if (input.method === 'account' && !order.customer_id) throw new Error('Замовлення без клієнта — оплата з рахунку неможлива')

    const shiftId = input.shift_id ?? null
    if (!shiftId) throw new Error('Спочатку відкрийте касову зміну')
    if (shiftId) {
      const openShift = this.db.prepare(`
        SELECT id FROM shifts
        WHERE id = ? AND tenant_id = ? AND status = 'open' AND deleted_at IS NULL
        LIMIT 1
      `).get(shiftId, tenantId)
      if (!openShift) throw new Error('Касову зміну не знайдено або вже закрито')
    }

    const timestamp = nowIso()
    const accountTransactionId = input.method === 'account' ? paymentId : null
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
      `).run(paymentId, tenantId, orderId, amount, input.method, boolInt(input.is_fiscal), shiftId, input.user_id ?? null, input.notes ?? null, timestamp, timestamp, timestamp)

      this.db.prepare(`
        UPDATE customer_orders
        SET total_paid = ?, status = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(nextPaid, nextStatus, timestamp, timestamp, orderId, tenantId)

      if (input.method === 'cash' && shiftId) {
        this.db.prepare(`
          INSERT INTO cash_operations (
            id, tenant_id, shift_id, user_id, type, source, amount, notes,
            dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'cash_in', 'cashbox', ?, ?, ?, ?, ?)
        `).run(paymentId, tenantId, shiftId, input.user_id ?? null, amount, input.notes ?? `Передоплата замовлення #${order.order_number ?? order.id.slice(0, 8)}`, timestamp, timestamp, timestamp)
      }

      this.addOutbox(tenantId, 'customer_order', orderId, 'order.payment_added', {
        order_id: orderId,
        payment_id: paymentId,
        amount,
        method: input.method,
        is_fiscal: input.is_fiscal === true,
        shift_id: shiftId,
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
  } = {}): { data: { success: true; sale_id: string; sale_number: string } } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const order = this.getOrder(orderId, tenantId)
    if (!order) throw new Error('Замовлення не знайдено')
    if (order.status === 'completed' && order.sale_id) {
      const existingSale = this.db.prepare(`
        SELECT id, sale_number
        FROM sales
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        LIMIT 1
      `).get(order.sale_id, tenantId) as { id: string; sale_number: string } | undefined
      if (!existingSale) throw new Error('Замовлення позначене виданим, але пов’язаний чек відсутній')
      return {
        data: {
          success: true,
          sale_id: existingSale.id,
          sale_number: existingSale.sale_number,
        },
      }
    }
    if (NON_ISSUEABLE.has(order.status)) throw new Error('Це замовлення не можна видати через касу')
    const remaining = this.remainingDue(order)
    if (remaining > 0) throw new Error('Не всі оплати проведено')

    const activeItems = order.items.filter((item: any) => item.item_status !== 'canceled')
    if (activeItems.length === 0) {
      throw new Error('У замовленні немає активних позицій для видачі')
    }
    if (!activeItems.every((item: any) => ['arrived', 'handed'].includes(item.item_status))) {
      throw new Error('Спочатку позначте всі активні позиції як отримані. Видача неготового замовлення заблокована.')
    }

    const unlinkedItems = activeItems.filter((item: any) => !item.product_id)
    if (unlinkedItems.length > 0) {
      const names = unlinkedItems.slice(0, 3).map((item: any) => `«${item.name || 'Без назви'}»`).join(', ')
      const suffix = unlinkedItems.length > 3 ? ` та ще ${unlinkedItems.length - 3}` : ''
      throw new Error(`Не можна видати замовлення. Не прив'язано до картки товару: ${names}${suffix}. Виберіть товар у кожній позиції.`)
    }

    const cashierId = input.user_id ?? order.manager_id ?? 'local'
    const shiftId = input.shift_id ?? this.pos.findOpenShift(cashierId, tenantId)
    if (!shiftId) throw new Error('Спочатку відкрийте касову зміну')
    const timestamp = nowIso()
    const saleId = randomUUID()
    const orderPayments = this.listPayments(orderId, tenantId)
    const paymentTotals = { cash: 0, card: 0, transfer: 0 }
    for (const payment of orderPayments) {
      const amount = Math.max(0, Math.round(num(payment.amount)))
      if (payment.method === 'card') paymentTotals.card += amount
      else if (payment.method === 'transfer' || payment.method === 'account') paymentTotals.transfer += amount
      else paymentTotals.cash += amount
    }
    const listedPaid = paymentTotals.cash + paymentTotals.card + paymentTotals.transfer
    const legacyPaid = Math.max(0, Math.round(num(order.total_paid ?? order.prepayment)) - listedPaid)
    if (legacyPaid > 0) {
      const legacyMethod = order.prepayment_method ?? input.payment_method
      if (legacyMethod === 'card') paymentTotals.card += legacyPaid
      else if (legacyMethod === 'transfer' || legacyMethod === 'account') paymentTotals.transfer += legacyPaid
      else paymentTotals.cash += legacyPaid
    }
    const usedMethods = [
      paymentTotals.cash > 0 ? 'cash' : null,
      paymentTotals.card > 0 ? 'card' : null,
      paymentTotals.transfer > 0 ? 'transfer' : null,
    ].filter(Boolean) as Array<'cash' | 'card' | 'transfer'>
    const paymentMethod: 'cash' | 'card' | 'mixed' | 'transfer' = usedMethods.length > 1
      ? 'mixed'
      : usedMethods[0] ?? (input.payment_method === 'card' || input.payment_method === 'mixed' ? input.payment_method : 'cash')
    const isFiscal = input.is_fiscal === true || orderPayments.some((payment) => payment.is_fiscal === 1)

    return this.db.transaction(() => {
      const settingsRow = this.db.prepare(
        "SELECT value_json FROM app_meta WHERE key = 'shop_settings' LIMIT 1",
      ).get() as { value_json: string } | undefined
      let allowNegativeQty = false
      if (settingsRow?.value_json) {
        try {
          allowNegativeQty = JSON.parse(settingsRow.value_json)?.allow_negative_qty !== false
        } catch {
          allowNegativeQty = false
        }
      }

      let subtotal = 0
      const preparedItems = activeItems.map((item: any) => {
        const product = this.db.prepare(`
          SELECT id, sku, name, purchase_price, qty_on_hand, is_service,
                 requires_core_return, core_deposit_amount
          FROM products
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
          LIMIT 1
        `).get(item.product_id, tenantId) as {
          id: string
          sku: string
          name: string
          purchase_price: number
          qty_on_hand: number
          is_service: number
          requires_core_return: number
          core_deposit_amount: number
        } | undefined
        if (!product) {
          throw new Error(`Не можна видати замовлення: товар «${item.name || item.product_id}» не знайдено в локальній базі`)
        }

        const qty = num(item.qty)
        if (qty <= 0) throw new Error(`Некоректна кількість у позиції «${item.name || product.name}»`)
        const unitPrice = Math.round(num(item.sell_price))
        const savedCoreDeposit = Math.max(0, Math.round(num(item.core_deposit_amount)))
        const coreDepositAmount = savedCoreDeposit > 0
          ? savedCoreDeposit
          : product.requires_core_return === 1
            ? Math.max(0, Math.round(num(product.core_deposit_amount)))
            : 0
        const lineAmount = Math.round(unitPrice * qty) + Math.round(coreDepositAmount * qty)
        subtotal += lineAmount
        if (product.is_service !== 1 && !allowNegativeQty && num(product.qty_on_hand) < qty) {
          throw new Error(`Недостатньо залишку для «${product.name}»: є ${num(product.qty_on_hand)}, потрібно ${qty}`)
        }

        return {
          id: randomUUID(),
          order_item_id: item.id,
          product_id: product.id,
          description: item.name || product.name,
          sku: item.sku || product.sku,
          qty,
          unit_price: unitPrice,
          purchase_price: Math.round(num(item.buy_price ?? product.purchase_price)),
          discount: 0,
          total: lineAmount,
          core_deposit_amount: coreDepositAmount,
          core_return_status: item.core_return_status
            && item.core_return_status !== 'none'
            ? item.core_return_status
            : coreDepositAmount > 0 ? 'pending' : 'none',
          is_service: product.is_service === 1,
          qty_on_hand: num(product.qty_on_hand),
        }
      })

      const discount = Math.max(0, Math.round(num(order.discount_amount)))
      const total = Math.max(0, subtotal - discount)
      const paidForOrder = paymentTotals.cash + paymentTotals.card + paymentTotals.transfer
      if (paidForOrder !== total) {
        const difference = Math.abs(paidForOrder - total)
        if (paidForOrder > total) {
          throw new Error(`Передоплата перевищує суму замовлення на ${(difference / 100).toFixed(2)} грн. Поверніть надлишок або зарахуйте його на рахунок клієнта.`)
        }
        throw new Error(`Не всі оплати проведено. Залишилось ${(difference / 100).toFixed(2)} грн.`)
      }
      const saleNumber = this.nextSaleNumber(tenantId, timestamp)
      const notes = `Видача замовлення #${order.order_number ?? order.id.slice(0, 8)}`

      this.db.prepare(`
        INSERT INTO sales (
          id, tenant_id, sale_number, customer_id, cashier_id, manager_id, shift_id,
          status, subtotal, discount, total, payment_method, is_debt, is_fiscal,
          cash_amount, card_amount, transfer_amount, debt_amount, pickup_cell, notes,
          completed_at, dirty_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
      `).run(
        saleId,
        tenantId,
        saleNumber,
        order.customer_id ?? null,
        cashierId,
        order.manager_id ?? cashierId,
        shiftId,
        subtotal,
        discount,
        total,
        paymentMethod,
        isFiscal ? 1 : 0,
        paymentTotals.cash,
        paymentTotals.card,
        paymentTotals.transfer,
        order.pickup_cell ?? null,
        notes,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )

      for (const item of preparedItems) {
        this.db.prepare(`
          INSERT INTO sale_items (
            id, tenant_id, sale_id, product_id, description, sku, qty, unit_price,
            purchase_price, discount, total, core_deposit_amount, core_return_status,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          item.core_deposit_amount,
          item.core_return_status,
          timestamp,
          timestamp,
        )

        if (!item.is_service) {
          const qtyAfter = item.qty_on_hand - item.qty
          this.db.prepare(`
            UPDATE products
            SET qty_on_hand = ?, dirty_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?
          `).run(qtyAfter, timestamp, timestamp, item.product_id, tenantId)
          this.db.prepare(`
            INSERT INTO inventory_movements (
              id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
              unit_cost, notes, dirty_at, created_at, updated_at
            )
            VALUES (?, ?, ?, 'order', ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            tenantId,
            item.product_id,
            orderId,
            -item.qty,
            qtyAfter,
            item.purchase_price,
            notes,
            timestamp,
            timestamp,
            timestamp,
          )
        }
      }

      this.db.prepare(`
        UPDATE stock_reserves
        SET released_at = ?, updated_at = ?
        WHERE tenant_id = ? AND order_id = ? AND released_at IS NULL AND deleted_at IS NULL
      `).run(timestamp, timestamp, tenantId, orderId)

      this.db.prepare(`
        UPDATE customer_order_items
        SET item_status = 'handed', dirty_at = ?, updated_at = ?
        WHERE tenant_id = ? AND order_id = ? AND deleted_at IS NULL
          AND item_status NOT IN ('canceled', 'handed')
      `).run(timestamp, timestamp, tenantId, orderId)

      this.db.prepare(`
        UPDATE customer_orders
        SET status = 'completed', sale_id = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(saleId, timestamp, timestamp, orderId, tenantId)

      const syncItems = preparedItems.map(({ qty_on_hand: _qtyOnHand, ...item }: any) => item)
      this.addOutbox(tenantId, 'customer_order', orderId, 'order.completed', {
        order_id: orderId,
        sale_id: saleId,
        sale_number: saleNumber,
        shift_id: shiftId,
        cashier_id: cashierId,
        customer_id: order.customer_id ?? null,
        manager_id: order.manager_id ?? cashierId,
        payment_method: paymentMethod,
        is_fiscal: isFiscal,
        subtotal,
        discount,
        total,
        cash_amount: paymentTotals.cash,
        card_amount: paymentTotals.card,
        transfer_amount: paymentTotals.transfer,
        debt_amount: 0,
        pickup_cell: order.pickup_cell ?? null,
        notes,
        completed_at: timestamp,
        order_payment_ids: orderPayments.map((payment) => payment.id),
        items: syncItems,
        sale: {
          id: saleId,
          sale_number: saleNumber,
          shift_id: shiftId,
          cashier_id: cashierId,
          customer_id: order.customer_id ?? null,
          manager_id: order.manager_id ?? cashierId,
          payment_method: paymentMethod,
          is_fiscal: isFiscal,
          subtotal,
          discount,
          total,
          cash_amount: paymentTotals.cash,
          card_amount: paymentTotals.card,
          transfer_amount: paymentTotals.transfer,
          debt_amount: 0,
          pickup_cell: order.pickup_cell ?? null,
          notes,
          completed_at: timestamp,
          items: syncItems,
        },
      }, timestamp)

      return { data: { success: true as const, sale_id: saleId, sale_number: saleNumber } }
    })
  }

  private nextSaleNumber(tenantId: string, timestamp: string): string {
    const date = dayStamp(new Date(timestamp))
    const device = this.db.deviceId.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase().padEnd(4, '0')
    const scope = `${tenantId}:sale:${date}:${device}`
    const row = this.db.prepare(`
      INSERT INTO local_sequences(scope, value, updated_at)
      VALUES (?, 1, ?)
      ON CONFLICT(scope) DO UPDATE SET value = value + 1, updated_at = excluded.updated_at
      RETURNING value
    `).get(scope, timestamp) as { value: number } | undefined
    return `L-${date.slice(2)}-${device}-${String(row?.value ?? 1).padStart(4, '0')}`
  }

  private nextOrderNumber(tenantId: string, timestamp: string): number {
    const scope = `${tenantId}:order`
    const row = this.db.prepare(`
      INSERT INTO local_sequences(scope, value, updated_at)
      VALUES (?, 1, ?)
      ON CONFLICT(scope) DO UPDATE SET value = value + 1, updated_at = excluded.updated_at
      RETURNING value
    `).get(scope, timestamp) as { value: number } | undefined
    return Number(row?.value ?? 1)
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
      sale_id: row.sale_id ?? null,
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
