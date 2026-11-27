import { createHash, randomUUID } from 'node:crypto'
import { assertOrderItemAmounts, assertOrderTotal } from './orderValidation'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'
import { LocalPosRepository } from './posRepository'
import { LocalWarehouseRepository } from './warehouseRepository'
import { LocalStaffRepository } from './staffRepository'
import { addStockQuantity, stockQuantity, subtractStockQuantity } from './stockQuantity'
import { reserveHolders, reservedStockProblem } from './pos/reservedStock'

function nowIso(): string { return new Date().toISOString() }
function dayStamp(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
}
function num(value: unknown): number { const n = Number(value ?? 0); return Number.isFinite(n) ? n : 0 }
function boolInt(value: unknown): number { return value === true || value === 1 ? 1 : 0 }
function pageInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback
}
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

/**
 * 22.11.2026 (перенесення з блокнота): нове замовлення може одразу отримати стан із зошита —
 * «замовлено, чекаємо», «прибуло», «клієнту подзвонили» або «видано» (перекреслене → архів).
 * Лише при СТВОРЕННІ; гроші й залишки не зачіпаються: оплати приймає тільки каса.
 */
const notebookOrderKey = (tenantId: string, orderId: string) => `notebook-order:${tenantId}:${orderId}`
/**
 * 24.11.2026 (план C2): мініатюра позиції замовлення (вирізана зі скриншота кошика або взята з довідника за артикулом).
 * Живе лише на головному ПК (app_meta), без зміни схеми бази: відкат на попередню збірку лишається можливим,
 * а на сервер мініатюри не їдуть — веб бачить їх через головний ПК.
 */
const itemPhotoKey = (tenantId: string, itemId: string) => `order-item-photo:${tenantId}:${itemId}`
const ITEM_PHOTO_PATTERN = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const ITEM_PHOTO_MAX_CHARS = 80_000
const photoSkuKey = (value: unknown) => String(value ?? '').normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '')
const NOTEBOOK_INITIAL_STATUSES = new Set(['ordered', 'arrived', 'called', 'archived'])
function initialOrderStatus(input: any): string {
  if (input?.initial_status === undefined || input.initial_status === null) return 'lead'
  if (!NOTEBOOK_INITIAL_STATUSES.has(String(input.initial_status))) throw new Error('Некоректний початковий стан замовлення')
  return String(input.initial_status)
}

function canChangeOrderStatus(from: string, to: string): boolean {
  return from === to || (ORDER_STATUS_TRANSITIONS[from] ?? []).includes(to)
}

export interface OrderPartSuggestion { name: string; sku: string; buy_price: number; sell_price: number; supplier_id: string | null; supplier_name: string | null; last_used_at: string; photo?: string | null }
export interface InvoiceArrivalOrder { order_id: string; order_number: number; customer_name: string | null; customer_phone: string | null; items: Array<{ name: string; qty: number }>; complete: boolean }
export interface InvoiceArrivalShortage { order_number: number; name: string; needed: number; available: number }
/** 23.11.2026 (план C3): позиція замовлення, яку ще треба замовити в постачальника. */
export interface SupplierOrderLine {
  item_id: string; order_id: string; order_number: number; name: string; sku: string | null; qty: number
  supplier_id: string | null; supplier_name: string | null; customer_name: string | null; customer_phone: string | null; created_at: string
}
type LocalOrderItemState = { item_status: string; sell_price: number; qty: number; core_deposit_amount: number }


type PaymentMethod = 'cash' | 'card' | 'transfer' | 'account' | 'bonus'

function isUnpricedOrder(order: any): boolean {
  if (!['lead', 'quoted', 'new'].includes(order.status) || num(order.total_amount) !== 0) return false
  const active = order.items.filter((item: any) => !['canceled', 'returned'].includes(item.item_status))
  return (order.items.length === 0 || active.length > 0)
    && active.every((item: any) => num(item.sell_price) === 0 && num(item.core_deposit_amount) === 0)
}

/** 22.11.2026 (етап 6): однаковий платіж за те саме замовлення протягом 2 хв — питаємо, чи це не повтор. */
export const ORDER_PAYMENT_REPEAT_WINDOW_MS = 120_000
export const ORDER_PAYMENT_REPEAT_MARK = 'Такий самий платіж за це замовлення вже внесено щойно'

export class LocalOrderRepository {
  private readonly pos: LocalPosRepository

  constructor(private readonly db: LocalDatabase) {
    this.pos = new LocalPosRepository(db)
  }

  listOrders(input: { tenant_id?: string; offset?: number; limit?: number; search?: string; status?: string; customer_id?: string; chat_id?: string; exclude_ids?: string[] } = {}): any[] {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const offset = pageInteger(input.offset ?? 0, 0, 0, Number.MAX_SAFE_INTEGER)
    const limit = pageInteger(input.limit ?? 200, 200, 1, 500)
    const raw = String(input.search ?? '').trim()
    const params: any[] = [tenantId]
    let searchSql = ''
    const statuses = String(input.status ?? '').split(',').map((status) => status.trim()).filter(Boolean)
    let statusSql = ''
    const excluded = Array.isArray(input.exclude_ids) ? input.exclude_ids.filter(id => typeof id === 'string').slice(0, 500) : []
    if (excluded.length) { statusSql += ` AND o.id NOT IN (${excluded.map(() => '?').join(',')})`; params.push(...excluded) }
    if (input.customer_id) { statusSql += ' AND o.customer_id = ?'; params.push(input.customer_id) }
    if (input.chat_id) { statusSql += ' AND o.chat_id = ?'; params.push(input.chat_id) }
    if (statuses.length > 0) {
      statusSql += ` AND o.status IN (${statuses.map(() => '?').join(',')})`
      params.push(...statuses)
    }

    if (raw) {
      const q = raw
      searchSql = ` AND (
        instr(CAST(o.order_number AS TEXT), ?) > 0
        OR instr(forsage_lower(o.kp_number), forsage_lower(?)) > 0
        OR instr(COALESCE(c.phone, ''), ?) > 0
        OR instr(forsage_lower(c.full_name), forsage_lower(?)) > 0
        OR instr(forsage_lower(c.card_barcode), forsage_lower(?)) > 0
        OR EXISTS (
          SELECT 1 FROM customer_order_items i
          WHERE i.order_id = o.id AND i.tenant_id = o.tenant_id AND i.deleted_at IS NULL
            AND (instr(forsage_lower(i.name), forsage_lower(?)) > 0 OR instr(forsage_lower(i.sku), forsage_lower(?)) > 0)
        )
      )`
      params.push(q, q, q, q, q, q, q)
    }
    params.push(limit, offset)
    const rows = this.db.prepare(`
      SELECT o.*, EXISTS(SELECT 1 FROM app_meta m WHERE m.key = 'notebook-order:' || o.tenant_id || ':' || o.id) AS from_notebook,
             c.id AS customer_id_join, c.phone AS customer_phone,
             c.full_name AS customer_full_name, c.card_barcode AS customer_card_barcode,
             COALESCE(c.bonus_balance, 0) AS customer_bonus_balance
      FROM customer_orders o
      LEFT JOIN customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
      WHERE o.tenant_id = ? AND o.deleted_at IS NULL ${statusSql} ${searchSql}
      ORDER BY o.updated_at DESC, o.id DESC
      LIMIT ? OFFSET ?
    `).all(...params) as any[]
    return this.decorateOrders(rows, tenantId)
  }

  countOrders(input: { tenant_id?: string; statuses?: string[] } = {}): number {
    const statuses = [...new Set(input.statuses ?? [])]
    if (!statuses.length) return 0
    if (statuses.length > 16 || statuses.some(status => !ACTIVE_STATUSES.includes(status) && !TERMINAL_STATUSES.has(status))) throw new Error('Некоректні статуси замовлень')
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM customer_orders
      WHERE tenant_id = ? AND deleted_at IS NULL AND status IN (${statuses.map(() => '?').join(',')})`)
      .get(input.tenant_id ?? DEFAULT_TENANT_ID, ...statuses) as { total: number }
    return Number(row.total)
  }

  saveOrder(input: any, orderId?: string): any {
    return this.db.transaction(() => this.saveOrderInTransaction(input, orderId))
  }

  /** Read-only acknowledgment: never repeat a save just to find out whether it committed. */
  getSaveResult(operationId: string, managerId: string, tenantId = DEFAULT_TENANT_ID, orderId?: string): any {
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(operationId)) throw new Error('Некоректний номер операції замовлення')
    const key = orderId ? `order-update:${tenantId}:${orderId}:${operationId}` : `order-create:${tenantId}:${operationId}`
    const receipt = this.db.prepare('SELECT value_json FROM app_meta WHERE key = ?').get(key) as { value_json: string } | undefined
    if (!receipt) return null
    const saved = JSON.parse(receipt.value_json)
    const order = this.getOrder(saved.id, tenantId)
    if ((saved.managerId ?? order?.manager_id) !== managerId) throw new Error('Операція замовлення належить іншому працівнику')
    if (!order) throw new Error('Раніше збережене замовлення видалене. Новий запис автоматично не створюється.')
    return order
  }

  /** Durable LAN acknowledgment. A lost response can be replayed without creating or reserving twice. */
  acceptOfflineOrder(envelope: any, session: { id: string; tenant_id: string }): any {
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(String(envelope?.operation_id ?? ''))) throw new Error('Некоректний номер операції замовлення')
    const tenantId = session.tenant_id
    const key = `lan-order-receipt:v1:${tenantId}:${session.id}:${envelope.operation_id}`
    const fingerprint = createHash('sha256').update(JSON.stringify(envelope)).digest('hex')
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT value_json FROM app_meta WHERE key = ?').get(key) as { value_json: string } | undefined
      if (row) {
        const receipt = JSON.parse(row.value_json)
        if (receipt.fingerprint !== fingerprint) throw new Error('Повтор операції містить інші дані')
        return receipt.result
      }
      const body = envelope.input
      if (!body || !Array.isArray(body.items)) throw new Error('Немає позицій замовлення')
      if (body.tenant_id && body.tenant_id !== tenantId) throw new Error('Операція належить іншому магазину')
      if (Number(body.prepayment || 0) || body.prepayment_method || body.exchange_source_order_id) throw new Error('Оплати та обмін не приймаються через чергу замовлень')
      if (envelope.order_id && !envelope.expected_updated_at) throw new Error('Немає версії замовлення для безпечного редагування')
      const existing = envelope.order_id ? this.getOrder(String(envelope.order_id), tenantId) : null
      for (const item of body.items) {
        const before = existing?.items?.find((row: any) => row.id === item.id)
        if ((item.item_status ?? 'pending') !== (before?.item_status ?? 'pending')) throw new Error('Статус товару змінився на головному ПК. Перевірте замовлення.')
        if (item.product_id && !this.db.prepare('SELECT id FROM products WHERE id=? AND tenant_id=? AND deleted_at IS NULL').get(item.product_id, tenantId)) throw new Error('Товар замовлення не знайдений на головному ПК')
      }
      if (body.customer_id && !this.db.prepare('SELECT id FROM customers WHERE id=? AND tenant_id=? AND deleted_at IS NULL').get(body.customer_id, tenantId)) throw new Error('Клієнт замовлення не знайдений на головному ПК')
      const result = this.saveOrder({
        tenant_id: tenantId, manager_id: session.id,
        customer_id: body.customer_id, vehicle_info: body.vehicle_info,
        comment: body.comment, source: body.source, items: body.items,
        expected_updated_at: envelope.expected_updated_at,
      }, envelope.order_id || undefined)
      this.db.prepare('INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)')
        .run(key, JSON.stringify({ fingerprint, result }), nowIso())
      return result
    })
  }

  private nextTimestamp(tenantId: string, orderId?: string): string {
    const prior = orderId ? this.db.prepare('SELECT updated_at FROM customer_orders WHERE id = ? AND tenant_id = ?')
      .get(orderId, tenantId) as { updated_at: string } | undefined : undefined
    const previous = prior ? Date.parse(prior.updated_at) : 0
    return new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString()
  }

  private saveOrderInTransaction(input: any, orderId?: string): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    if (input.operation_id && !/^[a-zA-Z0-9-]{16,80}$/.test(String(input.operation_id))) throw new Error('Некоректний номер операції замовлення')
    const receiptKey = input.operation_id ? (orderId ? `order-update:${tenantId}:${orderId}:${input.operation_id}` : `order-create:${tenantId}:${input.operation_id}`) : null
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    if (receiptKey) {
      const receipt = this.db.prepare('SELECT value_json FROM app_meta WHERE key = ?').get(receiptKey) as { value_json: string } | undefined
      if (receipt) {
        const saved = JSON.parse(receipt.value_json)
        if (saved.fingerprint !== fingerprint) throw new Error('Повтор створення замовлення містить інші дані')
        const prior = this.getOrder(saved.id, tenantId)
        if (!prior) throw new Error('Раніше створене замовлення видалене. Повтор не створено.')
        return prior
      }
    }
    const timestamp = this.nextTimestamp(tenantId, orderId)
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
    if (existing && input.expected_updated_at && input.expected_updated_at !== existing.updated_at) {
      throw new Error('Замовлення вже змінено. Ваші правки не записано: відкрийте актуальне замовлення та повторіть зміни.')
    }
    if (existing && TERMINAL_STATUSES.has(String(existing.status))) {
      throw new Error('Завершене, скасоване або архівне замовлення не можна редагувати')
    }
    const rawItems = Array.isArray(input.items) ? input.items : existing?.items ?? []
    const items = rawItems.map((item: any) => {
      assertOrderItemAmounts(item)
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
        qty: stockQuantity(Number(item.qty)),
        item_status: itemStatus,
        core_deposit_amount: coreDepositAmount,
        core_return_status: item.core_return_status
          ?? (coreDepositAmount > 0 ? 'pending' : 'none'),
      }
    })
    const totalAmount = items.reduce((sum: number, item: any) => {
      if (item.item_status === 'canceled') return sum
      const qty = num(item.qty)
      return sum
        + Math.round(num(item.sell_price) * qty)
        + Math.round(num(item.core_deposit_amount) * qty)
    }, 0)
    assertOrderTotal(totalAmount)
    // Та сама сторінка блокнота, сфотографована вдруге: той самий клієнт і ті самі позиції → дубль не створюємо.
    if (!existing && input.initial_status !== undefined && input.initial_status !== null) {
      const signature = (rows: any[]) => rows.filter(row => row.item_status !== 'canceled')
        .map(row => [String(row.name ?? '').trim().toLowerCase(), num(row.qty), Math.round(num(row.sell_price))].join('|')).sort().join('\n')
      const wanted = signature(items)
      const candidates = this.db.prepare(`SELECT id, order_number FROM customer_orders
        WHERE tenant_id = ? AND deleted_at IS NULL AND total_amount = ? AND COALESCE(customer_id, '') = ? AND COALESCE(comment, '') = ?`)
        .all(tenantId, totalAmount, input.customer_id ?? '', input.comment ?? '') as Array<{ id: string; order_number: number }>
      for (const candidate of candidates) {
        const rows = this.db.prepare('SELECT name, qty, sell_price, item_status FROM customer_order_items WHERE order_id = ? AND tenant_id = ? AND deleted_at IS NULL').all(candidate.id, tenantId) as any[]
        if (wanted && signature(rows) === wanted) throw new Error(`Таке замовлення вже є в програмі (№ ${candidate.order_number}). Дубль не створено.`)
      }
    }
    const orderNumber = existing?.order_number ?? this.nextOrderNumber(tenantId, timestamp)
    if (existing && input.initial_status !== undefined && input.initial_status !== null) throw new Error('Початковий стан задається лише при створенні замовлення')
    const status = existing?.status ?? initialOrderStatus(input)
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
        existing?.prepayment_is_fiscal ? 1 : 0,
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
        if (incomingIds.has(itemId)) throw new Error('Ідентифікатор рядка замовлення повторюється')
        const ownedItem = this.db.prepare('SELECT order_id, tenant_id FROM customer_order_items WHERE id = ?').get(itemId) as { order_id: string; tenant_id: string } | undefined
        if (ownedItem && (ownedItem.order_id !== id || ownedItem.tenant_id !== tenantId)) throw new Error('Рядок належить іншому замовленню')
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
        this.storeItemPhoto(tenantId, id, itemId, item.sku, item.photo_data_url)
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

      if (!existing && status !== 'lead') {
        this.db.prepare('INSERT OR IGNORE INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)')
          .run(notebookOrderKey(tenantId, id), JSON.stringify({ initial_status: status }), timestamp)
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
      this.syncOrderReserves(id, tenantId)
      if (receiptKey) this.db.prepare('INSERT INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)')
        .run(receiptKey, JSON.stringify({ id, fingerprint, managerId: input.manager_id }), timestamp)
    })
    return this.getOrder(id, tenantId)
  }

  private syncOrderReserves(orderId: string, tenantId: string): void {
    const order = this.getOrder(orderId, tenantId)
    if (!order || TERMINAL_STATUSES.has(order.status)) return
    const desired = new Map<string, number>()
    for (const item of order.items) {
      if (!item.product_id || item.item_status === 'canceled' || item.item_type === 'service') continue
      if (item.source_type !== 'warehouse' && item.item_status !== 'arrived') continue
      const product = this.db.prepare('SELECT is_service FROM products WHERE id = ? AND tenant_id = ?').get(item.product_id, tenantId) as { is_service: number } | undefined
      if (product?.is_service === 1) continue
      desired.set(item.product_id, addStockQuantity(desired.get(item.product_id) ?? 0, item.qty))
    }
    const old = this.db.prepare(`SELECT id, product_id, qty, expires_at FROM stock_reserves
      WHERE tenant_id = ? AND order_id = ? AND released_at IS NULL AND deleted_at IS NULL`)
      .all(tenantId, orderId) as Array<{ id: string; product_id: string; qty: number; expires_at: string | null }>
    if (old.length === desired.size && old.every(row => !row.expires_at && desired.get(row.product_id) === row.qty)) return
    const warehouse = new LocalWarehouseRepository(this.db)
    for (const row of old) warehouse.releaseReserve(row.id, tenantId)
    for (const [productId, qty] of desired) {
      warehouse.createReserve({ tenant_id: tenantId, order_id: orderId, product_id: productId,
        qty, customer_id: order.customer_id, user_id: order.manager_id })
    }
  }

  deleteOrder(orderId: string, tenantId = DEFAULT_TENANT_ID): { success: true } {
    const timestamp = this.nextTimestamp(tenantId, orderId)
    const order = this.getOrder(orderId, tenantId)
    if (!order) throw new Error('Замовлення не знайдено')
    const ledger = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS paid
      FROM order_payments
      WHERE tenant_id = ? AND order_id = ? AND deleted_at IS NULL
    `).get(tenantId, orderId) as { count: number; paid: number } | undefined
    // Замовлення, перенесене з блокнота, одразу має стан «замовлено» / «архів». Помилкове перенесення
    // треба мати змогу прибрати — поки по ньому не було грошей, чека й виданих позицій.
    const fromNotebook = this.isNotebookOrder(orderId, tenantId)
      && order.items.every((item: any) => !['handed', 'returned'].includes(String(item.item_status)))
    if (!(['lead', 'quoted', 'new'].includes(String(order.status)) || fromNotebook)
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
        UPDATE stock_reserves SET released_at = ?, dirty_at = ?, updated_at = ?
        WHERE order_id = ? AND tenant_id = ? AND released_at IS NULL AND deleted_at IS NULL
      `).run(timestamp, timestamp, timestamp, orderId, tenantId)
      this.addOutbox(tenantId, 'customer_order', orderId, 'order.deleted', fromNotebook ? { id: orderId, from_notebook: true } : { id: orderId }, timestamp)
    })
    return { success: true }
  }

  /**
   * 24.11.2026 (план C2, рішення власника: «одне завантаження фото — одна пачка»): скасувати все, що створила одна
   * загрузка блокнота, — одним рухом і цілком або ніяк. Лише замовлення з блокнота, по яких не було грошей, чека
   * й виданих позицій (ті самі правила, що й для видалення одного). Клієнт, заведений цією загрузкою, прибирається
   * лише тоді, коли в нього не лишилось жодного замовлення, чека й грошей; інакше лишається, і це видно у відповіді.
   */
  cancelNotebookBatch(input: { order_ids?: unknown; customer_ids?: unknown }, tenantId = DEFAULT_TENANT_ID): { orders: number; customers: number; kept_customers: number } {
    const ids = (value: unknown, max: number, label: string): string[] => {
      if (value === undefined || value === null) return []
      if (!Array.isArray(value) || value.length > max) throw new Error(`Некоректний перелік: ${label}`)
      const list = [...new Set(value)]
      if (!list.every(id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(id))) throw new Error(`Некоректний перелік: ${label}`)
      return list as string[]
    }
    const orderIds = ids(input?.order_ids, 100, 'замовлення')
    const customerIds = ids(input?.customer_ids, 100, 'клієнти')
    if (orderIds.length === 0) throw new Error('У пачці немає замовлень')
    let customers = 0, kept = 0
    this.db.transaction(() => {
      for (const orderId of orderIds) {
        const order = this.getOrder(orderId, tenantId)
        if (!order) throw new Error('Замовлення з пачки не знайдено — можливо, його вже видалили. Нічого не змінено.')
        if (!this.isNotebookOrder(orderId, tenantId)) throw new Error(`Замовлення № ${order.order_number} не з блокнота — пачку не скасовано.`)
        try { this.deleteOrder(orderId, tenantId) } catch (error) {
          throw new Error(`Замовлення № ${order.order_number}: ${error instanceof Error ? error.message : 'не видаляється'} Пачку не скасовано, нічого не змінено.`)
        }
      }
      for (const customerId of customerIds) {
        const customer = this.db.prepare('SELECT * FROM customers WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(customerId, tenantId) as Record<string, unknown> | undefined
        if (!customer) continue
        const money = ['debt_balance', 'deposit_balance', 'bonus_balance'].some(column => Number(customer[column] ?? 0) !== 0)
        const orders = this.db.prepare('SELECT 1 FROM customer_orders WHERE customer_id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1').get(customerId, tenantId)
        const sales = this.db.prepare('SELECT 1 FROM sales WHERE customer_id = ? AND tenant_id = ? LIMIT 1').get(customerId, tenantId)
        if (money || orders || sales) { kept++; continue }
        const timestamp = nowIso()
        this.db.prepare('UPDATE customers SET deleted_at = ?, dirty_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?').run(timestamp, timestamp, timestamp, customerId, tenantId)
        this.db.prepare('UPDATE customer_vehicles SET deleted_at = ?, dirty_at = ?, updated_at = ? WHERE customer_id = ? AND tenant_id = ? AND deleted_at IS NULL').run(timestamp, timestamp, timestamp, customerId, tenantId)
        this.addOutbox(tenantId, 'customer', customerId, 'customer.deleted', { id: customerId }, timestamp)
        customers++
      }
    })
    return { orders: orderIds.length, customers, kept_customers: kept }
  }

  updateOrderStatus(orderId: string, status: string, tenantId = DEFAULT_TENANT_ID): any {
    return this.db.transaction(() => this.updateOrderStatusInTransaction(orderId, status, tenantId))
  }

  private updateOrderStatusInTransaction(orderId: string, status: string, tenantId: string): any {
    const timestamp = this.nextTimestamp(tenantId, orderId)
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
    const timestamp = this.nextTimestamp(tenantId, orderId)
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
    this.syncOrderReserves(orderId, tenantId)
    const activeItems = this.db.prepare(`
      SELECT item_status, sell_price, qty, core_deposit_amount
      FROM customer_order_items
      WHERE tenant_id = ? AND order_id = ? AND deleted_at IS NULL AND item_status <> 'canceled'
    `).all(tenantId, orderId) as LocalOrderItemState[]
    const totalAmount = activeItems.reduce((sum, item) => sum
      + Math.round(num(item.sell_price) * stockQuantity(item.qty))
      + Math.round(num(item.core_deposit_amount) * stockQuantity(item.qty)), 0)
    assertOrderTotal(totalAmount)
    const nextStatus = activeItems.length > 0 && activeItems.every((item) => ['arrived', 'handed', 'returned'].includes(item.item_status))
      ? 'ready'
      : activeItems.some((item) => item.item_status === 'ordered')
        ? 'ordered'
        : 'new'
    this.db.prepare(`
      UPDATE customer_orders SET total_amount = ?, status = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(totalAmount, nextStatus, timestamp, timestamp, orderId, tenantId)
    // syncOrderReserves above already recalculated the complete active order.
    // Releasing by product here would also release another active line of that product.
    this.addOutbox(tenantId, 'customer_order', orderId, 'order.item_status_updated', {
      order_id: orderId, item_id: itemId, item_status: itemStatus,
    }, timestamp)
    })
    return this.getOrder(orderId, tenantId)
  }

  cancelOrder(orderId: string, input: { refund_prepayment?: boolean; keep_as_credit?: boolean; reason?: string | null; tenant_id?: string; user_id?: string | null } = {}): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const order = this.getOrder(orderId, tenantId)
    if (!order) throw new Error('Замовлення не знайдено')
    if (order.status === 'completed') throw new Error('Завершене замовлення не можна скасувати')
    if (order.status === 'canceled') return order

    const ledger = this.db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS paid,
             COALESCE(SUM(CASE WHEN method = 'bonus' THEN amount ELSE 0 END), 0) AS bonus
      FROM order_payments
      WHERE tenant_id = ? AND order_id = ? AND deleted_at IS NULL
    `).get(tenantId, orderId) as { paid: number; bonus: number } | undefined
    const totalPaid = Math.max(num(order.total_paid), num(order.prepayment), num(ledger?.paid))
    // Рішення власника 20.11.2026: бонуси й передоплата — окремо. Оплачене бонусами повертається в бонуси.
    const bonusPaid = Math.min(totalPaid, Math.max(0, num(ledger?.bonus)))
    const paid = totalPaid - bonusPaid
    if (paid > 0 && input.refund_prepayment) {
      throw new Error('Менеджер скасовує замовлення із зарахуванням оплати на рахунок клієнта. Фактичну видачу грошей потім проводить касир.')
    }
    if (totalPaid > 0 && !order.customer_id) {
      throw new Error('До оплаченого замовлення не прив’язаний клієнт. Спочатку виберіть клієнта в замовленні.')
    }

    const timestamp = this.nextTimestamp(tenantId, orderId)
    const reason = String(input.reason ?? '').trim()
    const priorComment = String(order.comment ?? '').trim()
    const comment = reason ? `${priorComment ? `${priorComment}\n` : ''}Скасування: ${reason}` : priorComment || null
    const bonusRefundId = bonusPaid > 0 ? randomUUID() : null
    let bonusBalance: number | null = null
    this.db.transaction(() => {
      if (bonusPaid > 0 && order.customer_id && bonusRefundId) {
        const customer = this.db.prepare(`
          SELECT id, COALESCE(bonus_balance, 0) AS bonus_balance FROM customers
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1
        `).get(order.customer_id, tenantId) as { id: string; bonus_balance: number } | undefined
        if (!customer) throw new Error('Клієнта замовлення не знайдено')
        bonusBalance = Number(customer.bonus_balance ?? 0) + bonusPaid
        this.db.prepare(`
          UPDATE customers SET bonus_balance = ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(bonusBalance, timestamp, timestamp, customer.id, tenantId)
        this.db.prepare(`
          INSERT INTO bonus_transactions (
            id, tenant_id, customer_id, amount, transaction_type, source_sale_id,
            description, created_by, dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'refund', NULL, ?, ?, ?, ?, ?)
        `).run(
          bonusRefundId, tenantId, customer.id, bonusPaid,
          `Повернення бонусів: скасування замовлення №${String(order.order_number ?? orderId)}`,
          input.user_id ?? null, timestamp, timestamp, timestamp,
        )
      }
      let customerBalance: number | null = null
      if (paid > 0 && order.customer_id) {
        const existingCredit = this.db.prepare(`
          SELECT amount, balance_after
          FROM customer_deposit_transactions
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
          LIMIT 1
        `).get(orderId, tenantId) as { amount: number; balance_after: number } | undefined
        if (existingCredit) {
          customerBalance = Number(existingCredit.balance_after)
        } else {
          const customer = this.db.prepare(`
            SELECT id, COALESCE(deposit_balance, 0) AS deposit_balance
            FROM customers
            WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
            LIMIT 1
          `).get(order.customer_id, tenantId) as { id: string; deposit_balance: number } | undefined
          if (!customer) throw new Error('Клієнта замовлення не знайдено')
          customerBalance = Number(customer.deposit_balance ?? 0) + paid
          this.db.prepare(`
            UPDATE customers
            SET deposit_balance = ?, dirty_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?
          `).run(customerBalance, timestamp, timestamp, customer.id, tenantId)
          this.db.prepare(`
            INSERT INTO customer_deposit_transactions (
              id, tenant_id, customer_id, amount, balance_after, method, order_id,
              notes, created_by, dirty_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'account', ?, ?, ?, ?, ?, ?)
          `).run(
            orderId, tenantId, customer.id, paid, customerBalance, orderId,
            `Скасування замовлення №${String(order.order_number ?? orderId)}`,
            input.user_id ?? null, timestamp, timestamp, timestamp,
          )
          this.addOutbox(tenantId, 'customer', customer.id, 'customer.deposit_changed', {
            customer_id: customer.id,
            transaction_id: orderId,
            amount: paid,
            method: 'account',
            order_id: orderId,
            notes: `Скасування замовлення №${String(order.order_number ?? orderId)}`,
            created_by: input.user_id ?? null,
            created_at: timestamp,
          }, timestamp)
        }
      }
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
        keep_as_credit: paid > 0,
        reason: input.reason ?? null,
        credited_amount: paid,
        customer_balance: customerBalance,
        bonus_refunded: bonusPaid,
        bonus_refund_transaction_id: bonusRefundId,
        bonus_balance: bonusBalance,
      }, timestamp)
    })
    return this.getOrder(orderId, tenantId)
  }
  /** Мініатюра позиції: лише картинка, не більша за 80 000 знаків; некоректна мовчки не зберігається (замовлення важливіше). */
  private storeItemPhoto(tenantId: string, orderId: string, itemId: string, sku: unknown, dataUrl: unknown): void {
    // null — людина прибрала мініатюру в бланку.
    if (dataUrl === null) { this.db.prepare('DELETE FROM app_meta WHERE key = ?').run(itemPhotoKey(tenantId, itemId)); return }
    if (typeof dataUrl !== 'string' || dataUrl.length > ITEM_PHOTO_MAX_CHARS || !ITEM_PHOTO_PATTERN.test(dataUrl)) return
    this.db.prepare(`INSERT INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(itemPhotoKey(tenantId, itemId), JSON.stringify({ data_url: dataUrl, sku_key: photoSkuKey(sku), order_id: orderId }), nowIso())
  }

  /** Мініатюри позицій замовлення: { ідентифікатор позиції: картинка }. */
  listItemPhotos(orderId: string, tenantId = DEFAULT_TENANT_ID): Record<string, string> {
    if (typeof orderId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(orderId)) throw new Error('Некоректне замовлення')
    const items = this.db.prepare('SELECT id FROM customer_order_items WHERE order_id = ? AND tenant_id = ? AND deleted_at IS NULL').all(orderId, tenantId) as Array<{ id: string }>
    const result: Record<string, string> = {}
    for (const item of items) {
      const row = this.db.prepare('SELECT value_json FROM app_meta WHERE key = ?').get(itemPhotoKey(tenantId, item.id)) as { value_json: string } | undefined
      try { const value = row ? JSON.parse(row.value_json) as { data_url?: unknown } : null; if (typeof value?.data_url === 'string' && ITEM_PHOTO_PATTERN.test(value.data_url)) result[item.id] = value.data_url } catch { /* пропуск */ }
    }
    return result
  }

  /** Довідник запчастин: остання мініатюра, збережена для цього артикула (точний збіг, від 4 знаків). */
  partPhoto(sku: unknown, tenantId = DEFAULT_TENANT_ID): string | null {
    const key = photoSkuKey(sku)
    if (key.length < 4) return null
    const row = this.db.prepare(`SELECT value_json FROM app_meta WHERE key LIKE ? AND json_extract(value_json, '$.sku_key') = ?
      ORDER BY updated_at DESC LIMIT 1`).get(`order-item-photo:${tenantId}:%`, key) as { value_json: string } | undefined
    try { const value = row ? JSON.parse(row.value_json) as { data_url?: unknown } : null; return typeof value?.data_url === 'string' && ITEM_PHOTO_PATTERN.test(value.data_url) ? value.data_url : null } catch { return null }
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

  /**
   * 23.11.2026 (план C3, етап 10): «Замовити в постачальника» — позиції відкритих замовлень, які ще не замовлено
   * (не зі складу, не послуга, стан «чекає»). Порядок — черга замовлень; групує екран за постачальником.
   */
  listSupplierOrderLines(tenantId = DEFAULT_TENANT_ID): SupplierOrderLine[] {
    return this.db.prepare(`
      SELECT i.id AS item_id, i.order_id, o.order_number, i.name, i.sku, i.qty, i.supplier_id, s.name AS supplier_name,
             c.full_name AS customer_name, c.phone AS customer_phone, i.created_at
      FROM customer_order_items i
      JOIN customer_orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      LEFT JOIN customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
      WHERE i.tenant_id = ? AND i.deleted_at IS NULL AND o.deleted_at IS NULL
        AND i.item_status = 'pending' AND i.source_type <> 'warehouse' AND i.item_type <> 'service'
        AND o.status NOT IN ('completed', 'canceled', 'archived')
      ORDER BY o.created_at ASC, i.created_at ASC
      LIMIT 500
    `).all(tenantId).map((row: any) => ({ ...row, qty: num(row.qty) })) as SupplierOrderLine[]
  }

  /** 23.11.2026 (план C3): відмітити позиції «замовлено в постачальника» одним рухом — усе або нічого. */
  bulkOrdered(itemIds: string[], tenantId = DEFAULT_TENANT_ID): { updated: number } {
    const uniqueIds = [...new Set(Array.isArray(itemIds) ? itemIds : [])].filter(id => typeof id === 'string' && id.length <= 128)
    if (uniqueIds.length === 0) throw new Error('Оберіть хоча б одну позицію')
    if (uniqueIds.length > 500) throw new Error('Забагато позицій за раз')
    const placeholders = uniqueIds.map(() => '?').join(',')
    const rows = this.db.prepare(`
      SELECT id, order_id, item_status FROM customer_order_items
      WHERE tenant_id = ? AND deleted_at IS NULL AND id IN (${placeholders})
    `).all(tenantId, ...uniqueIds) as Array<{ id: string; order_id: string; item_status: string }>
    if (rows.length !== uniqueIds.length) throw new Error('Одна або кілька позицій не знайдені у вашому магазині')
    let updated = 0
    this.db.transaction(() => {
      for (const row of rows) {
        // Уже замовлене чи прибуле не чіпаємо: інший ПК міг відмітити раніше.
        if (row.item_status !== 'pending') continue
        this.updateOrderItemStatus(row.order_id, row.id, 'ordered', tenantId)
        updated++
      }
    })
    return { updated }
  }

  bulkArrival(itemIds: string[], tenantId = DEFAULT_TENANT_ID): { updated: number } {
    const uniqueIds = [...new Set(itemIds)]
    if (uniqueIds.length === 0) throw new Error('Оберіть хоча б одну позицію')
    const placeholders = uniqueIds.map(() => '?').join(',')
    const ownedRows = this.db.prepare(`
      SELECT id, order_id FROM customer_order_items
      WHERE tenant_id = ? AND deleted_at IS NULL AND id IN (${placeholders})
    `).all(tenantId, ...uniqueIds) as Array<{ id: string; order_id: string }>
    if (ownedRows.length !== uniqueIds.length) {
      throw new Error('Одна або кілька позицій не знайдені у вашому магазині')
    }

    const timestamp = nowIso()
    this.db.transaction(() => {
      for (const row of ownedRows) this.updateOrderItemStatus(row.order_id, row.id, 'arrived', tenantId)
      this.addOutbox(tenantId, 'customer_order', 'bulk', 'order.items_arrived', { item_ids: uniqueIds }, timestamp)
    })
    return { updated: uniqueIds.length }
  }
  /**
   * 22.11.2026 (етап 3 плану): довідник запчастин «під замовлення» — те, що вже замовляли клієнтам і чого
   * немає на складі карткою. Окремої таблиці немає: довідник — це історія позицій замовлень без картки товару.
   * Повертає останній запис для кожної пари «назва + артикул»: закупка, ціна продажу, постачальник.
   */
  suggestOrderParts(query: string, tenantId = DEFAULT_TENANT_ID, limit = 8): OrderPartSuggestion[] {
    const needle = String(query ?? '').normalize('NFKC').trim().toLowerCase()
    if (needle.length < 2 || needle.length > 80) return []
    const compact = needle.replace(/[^\p{L}\p{N}]/gu, '')
    // SQLite не вміє порівнювати кирилицю без урахування регістру, тому відбір — у коді, по останніх позиціях.
    const rows = (this.db.prepare(`SELECT i.name, i.sku, i.buy_price, i.sell_price, i.supplier_id, s.name AS supplier_name, i.updated_at
      FROM customer_order_items i
      JOIN customer_orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
      LEFT JOIN suppliers s ON s.id = i.supplier_id AND s.tenant_id = i.tenant_id
      WHERE i.tenant_id = ? AND i.deleted_at IS NULL AND o.deleted_at IS NULL AND i.product_id IS NULL
        AND i.item_type <> 'service' AND i.item_status <> 'canceled' AND trim(i.name) <> ''
      ORDER BY i.updated_at DESC LIMIT 5000`).all(tenantId) as Array<{ name: string; sku: string | null; buy_price: number; sell_price: number; supplier_id: string | null; supplier_name: string | null; updated_at: string }>)
      .filter(row => {
        const name = row.name.normalize('NFKC').toLowerCase(), sku = String(row.sku ?? '').normalize('NFKC').toLowerCase()
        return name.includes(needle) || sku.includes(needle) || (compact.length >= 2 && sku.replace(/[^\p{L}\p{N}]/gu, '').includes(compact))
      })
    const seen = new Set<string>(), result: OrderPartSuggestion[] = []
    for (const row of rows) {
      const key = row.name.trim().toLowerCase() + '|' + String(row.sku ?? '').trim().toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ name: row.name.trim(), sku: String(row.sku ?? '').trim(), buy_price: Math.round(num(row.buy_price)), sell_price: Math.round(num(row.sell_price)),
        supplier_id: row.supplier_id, supplier_name: row.supplier_name, last_used_at: row.updated_at, photo: this.partPhoto(row.sku, tenantId) })
      if (result.length >= Math.max(1, Math.min(20, limit))) break
    }
    return result
  }

  /**
   * 22.11.2026 (етап 10 плану): проведена накладна сама відмічає «прибуло» в замовленнях, які чекають цей товар,
   * і повертає список «кому подзвонити». Збіг лише точний: та сама картка товару або той самий артикул
   * (артикул картки чи її крос-номер). Розподіл — за чергою замовлень; якщо товару менше, ніж чекають,
   * позиція лишається «чекаємо» і потрапляє в «не вистачило». Повтор для тієї ж накладної нічого не змінює.
   */
  applyInvoiceArrival(invoiceId: string, tenantId = DEFAULT_TENANT_ID): { orders: InvoiceArrivalOrder[]; shortages: InvoiceArrivalShortage[]; already_applied: boolean } {
    if (typeof invoiceId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(invoiceId)) throw new Error('Некоректна накладна')
    const key = `order-arrival:${tenantId}:${invoiceId}`
    return this.db.transaction(() => {
      const receipt = this.db.prepare('SELECT value_json FROM app_meta WHERE key = ?').get(key) as { value_json: string } | undefined
      if (receipt) return { ...JSON.parse(receipt.value_json), already_applied: true }
      const invoice = this.db.prepare('SELECT status FROM supply_invoices WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(invoiceId, tenantId) as { status: string } | undefined
      if (!invoice) throw new Error('Накладну не знайдено')
      if (invoice.status !== 'posted') throw new Error('Прибуття в замовленнях відмічається лише після проведення накладної')
      const skuKey = (value: unknown) => String(value ?? '').normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '')
      const received = this.db.prepare(`SELECT i.product_id, SUM(i.qty) AS qty, p.sku, p.name FROM supply_invoice_items i
        JOIN products p ON p.id = i.product_id AND p.tenant_id = i.tenant_id
        WHERE i.invoice_id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL GROUP BY i.product_id`).all(invoiceId, tenantId) as Array<{ product_id: string; qty: number; sku: string; name: string }>
      const left = new Map<string, number>(), productBySku = new Map<string, string | null>()
      const remember = (code: string, productId: string) => { if (code.length >= 4) productBySku.set(code, productBySku.has(code) && productBySku.get(code) !== productId ? null : productId) }
      for (const row of received) {
        left.set(row.product_id, num(row.qty))
        remember(skuKey(row.sku), row.product_id)
        for (const cross of this.db.prepare('SELECT cross_number FROM product_cross_numbers WHERE product_id = ? AND tenant_id = ? AND deleted_at IS NULL').all(row.product_id, tenantId) as Array<{ cross_number: string }>) remember(skuKey(cross.cross_number), row.product_id)
      }
      const waiting = this.db.prepare(`SELECT i.id, i.order_id, i.name, i.sku, i.product_id, i.qty, o.order_number
        FROM customer_order_items i JOIN customer_orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
        WHERE i.tenant_id = ? AND i.deleted_at IS NULL AND o.deleted_at IS NULL AND i.item_status IN ('pending', 'ordered')
          AND i.item_type <> 'service' AND o.status NOT IN ('completed', 'canceled', 'archived')
        ORDER BY o.created_at ASC, i.created_at ASC`).all(tenantId) as Array<{ id: string; order_id: string; name: string; sku: string | null; product_id: string | null; qty: number; order_number: number }>
      const touched = new Map<string, Array<{ name: string; qty: number }>>(), shortages: InvoiceArrivalShortage[] = []
      for (const item of waiting) {
        const productId = item.product_id && left.has(item.product_id) ? item.product_id : productBySku.get(skuKey(item.sku)) ?? null
        if (!productId) continue
        const need = num(item.qty), available = left.get(productId) ?? 0
        if (available < need) { shortages.push({ order_number: item.order_number, name: item.name, needed: need, available }); continue }
        try {
          // Окрема вкладена транзакція на позицію: якщо резерв неможливий (залишок пішов у мінус раніше),
          // ця позиція лишається «чекаємо», а решта накладної відмічається як слід.
          this.db.transaction(() => {
        if (!item.product_id) {
          // Товар тепер на складі: позиція отримує картку, щоб резерв і видача списали саме його.
          const timestamp = this.nextTimestamp(tenantId, item.order_id)
          this.db.prepare('UPDATE customer_order_items SET product_id = ?, dirty_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?').run(productId, timestamp, timestamp, item.id, tenantId)
        }
        this.updateOrderItemStatus(item.order_id, item.id, 'arrived', tenantId)
          })
        } catch {
          shortages.push({ order_number: item.order_number, name: item.name, needed: need, available: 0 })
          continue
        }
        left.set(productId, subtractStockQuantity(available, need))
        touched.set(item.order_id, [...(touched.get(item.order_id) ?? []), { name: item.name, qty: need }])
      }
      const orders: InvoiceArrivalOrder[] = [...touched].map(([orderId, items]) => {
        const order = this.getOrder(orderId, tenantId)
        this.addOutbox(tenantId, 'customer_order', orderId, 'order.updated', order, this.nextTimestamp(tenantId, orderId))
        const customer = order.customer_id ? this.db.prepare('SELECT full_name, phone FROM customers WHERE id = ? AND tenant_id = ?').get(order.customer_id, tenantId) as { full_name: string | null; phone: string | null } | undefined : undefined
        return { order_id: orderId, order_number: order.order_number, customer_name: customer?.full_name ?? null, customer_phone: customer?.phone ?? null,
          items, complete: order.status === 'ready' }
      })
      const result = { orders, shortages }
      this.db.prepare('INSERT INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify(result), nowIso())
      return { ...result, already_applied: false }
    })
  }

  listReadyOrders(input: { tenant_id?: string; search?: string; customer_id?: string | null; limit?: number } = {}): any[] {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const search = String(input.search ?? '').trim().toLowerCase()
    const limit = pageInteger(input.limit ?? 80, 80, 1, 200)
    const statusPlaceholders = ACTIVE_STATUSES.map(() => '?').join(',')
    const params: any[] = [tenantId, ...ACTIVE_STATUSES]
    let where = `o.tenant_id = ? AND o.deleted_at IS NULL AND o.status IN (${statusPlaceholders})`
    if (input.customer_id) {
      where += ' AND o.customer_id = ?'
      params.push(input.customer_id)
    }
    if (search) {
      where += ` AND (
        instr(CAST(o.order_number AS TEXT), ?) > 0
        OR instr(forsage_lower(o.kp_number), ?) > 0
        OR instr(COALESCE(c.phone, ''), ?) > 0
        OR instr(forsage_lower(c.full_name), ?) > 0
        OR instr(forsage_lower(c.card_barcode), ?) > 0
      )`
      const q = search
      params.push(q, q, q, q, q)
    }
    params.push(limit)

    const rows = this.db.prepare(`
      SELECT o.*, EXISTS(SELECT 1 FROM app_meta m WHERE m.key = 'notebook-order:' || o.tenant_id || ':' || o.id) AS from_notebook,
             c.id AS customer_id_join, c.phone AS customer_phone,
             c.full_name AS customer_full_name, c.card_barcode AS customer_card_barcode,
             COALESCE(c.bonus_balance, 0) AS customer_bonus_balance
      FROM customer_orders o
      LEFT JOIN customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
      WHERE ${where}
      ORDER BY CASE o.status WHEN 'ready' THEN 0 WHEN 'arrived' THEN 1 ELSE 2 END,
               o.updated_at DESC
      LIMIT ?
    `).all(...params) as any[]
    return this.decorateOrders(rows, tenantId)
  }

  getOrder(id: string, tenantId = DEFAULT_TENANT_ID): any | null {
    const row = this.db.prepare(`
      SELECT o.*, EXISTS(SELECT 1 FROM app_meta m WHERE m.key = 'notebook-order:' || o.tenant_id || ':' || o.id) AS from_notebook,
             c.id AS customer_id_join, c.phone AS customer_phone,
             c.full_name AS customer_full_name, c.card_barcode AS customer_card_barcode,
             COALESCE(c.bonus_balance, 0) AS customer_bonus_balance
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
    /** 22.11.2026: людина підтвердила, що це ще один платіж, а не повтор щойно внесеного. */
    confirm_repeat?: boolean
  }): { data: any; order: any } {
    return this.db.transaction(() => this.addPaymentInTransaction(orderId, input))
  }

  private addPaymentInTransaction(orderId: string, input: Parameters<LocalOrderRepository['addPayment']>[1]): { data: any; order: any } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const amount = input.amount
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Некоректна сума')
    if (!['cash', 'card', 'transfer', 'account', 'bonus'].includes(input.method)) throw new Error('Невідомий спосіб оплати')
    if (input.method === 'bonus' && input.is_fiscal) throw new Error('Оплата бонусами не фіскалізується. Оплату не записано.')
    if (input.is_fiscal) throw new Error('Фіскалізація передоплати замовлення ще не підтримується цим каналом. Фіскальний чек не створено; оплату не записано.')
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
        && existingPayment.shift_id === (input.shift_id ?? null)
        && existingPayment.created_by === (input.user_id ?? null)
        && existingPayment.is_fiscal === boolInt(input.is_fiscal)
        && existingPayment.notes === (input.notes ?? null)
        && !existingPayment.deleted_at
      if (!sameRequest) throw new Error('Цей ідентифікатор платежу вже використано для іншої оплати')
      return { data: existingPayment, order }
    }
    if (order.status === 'completed') throw new Error('Замовлення вже видане')
    if (input.is_fiscal) throw new Error('Фіскалізація передоплати замовлення ще не підтримується цим каналом. Фіскальний чек не створено; оплату не записано.')
    if (['canceled', 'cancelled', 'archived'].includes(order.status)) throw new Error('Замовлення скасоване або архівоване. Оплату не прийнято.')
    const remaining = this.remainingDue(order)
    const canAcceptOpenDraftDeposit = isUnpricedOrder(order)
    if (!canAcceptOpenDraftDeposit && amount > remaining) throw new Error('Сума перевищує залишок до сплати')
    if (input.method === 'account' && !order.customer_id) throw new Error('Замовлення без клієнта — оплата з рахунку неможлива')
    if (input.method === 'bonus' && !order.customer_id) throw new Error('Замовлення без клієнта — оплата бонусами неможлива')

    // 22.11.2026 (етап 6, два ПК): той самий платіж за те саме замовлення щойно вже внесено — найімовірніше,
    // задаток прийняли двічі (на касі й на ПК менеджера). Без явного підтвердження не записуємо.
    if (!input.confirm_repeat) {
      const since = new Date(Date.now() - ORDER_PAYMENT_REPEAT_WINDOW_MS).toISOString()
      const recent = this.db.prepare(`
        SELECT p.created_at, COALESCE(u.full_name, '') AS author FROM order_payments p
        LEFT JOIN staff_users u ON u.id = p.created_by AND u.tenant_id = p.tenant_id
        WHERE p.tenant_id = ? AND p.order_id = ? AND p.amount = ? AND p.method = ? AND p.deleted_at IS NULL AND p.created_at >= ?
        ORDER BY p.created_at DESC LIMIT 1
      `).get(tenantId, orderId, amount, input.method, since) as { created_at: string; author: string } | undefined
      if (recent) throw new Error(`${ORDER_PAYMENT_REPEAT_MARK}: ${(amount / 100).toFixed(2)} грн${recent.author ? ' (' + recent.author + ')' : ''}. Якщо це справді ще один платіж — підтвердіть.`)
    }

    const shiftId = input.shift_id ?? null
    if (!shiftId) throw new Error('Спочатку відкрийте касову зміну')
    if (shiftId) {
      const openShift = this.db.prepare(`
        SELECT id FROM shifts
        WHERE id = ? AND tenant_id = ? AND cashier_id = ? AND status = 'open' AND deleted_at IS NULL
        LIMIT 1
      `).get(shiftId, tenantId, input.user_id ?? '')
      if (!openShift) throw new Error('Касову зміну не знайдено або вже закрито')
    }

    const timestamp = this.nextTimestamp(tenantId, orderId)
    const accountTransactionId = input.method === 'account' ? paymentId : null
    let bonusBalanceAfter: number | null = null
    const nextPaid = Math.max(num(order.total_paid), num(order.prepayment)) + amount
    if (!Number.isSafeInteger(nextPaid)) throw new Error('Сума оплат завелика')
    const nextStatus = !canAcceptOpenDraftDeposit && (order.status === 'lead' || order.status === 'quoted') && nextPaid > 0 ? 'new' : order.status

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

      // Рішення власника 20.11.2026: бонуси — гроші клієнта, ними можна внести передоплату замовлення.
      if (input.method === 'bonus') {
        const customer = this.db.prepare(`
          SELECT id, COALESCE(bonus_balance, 0) AS bonus_balance
          FROM customers
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
          LIMIT 1
        `).get(order.customer_id, tenantId) as { id: string; bonus_balance: number } | undefined
        if (!customer) throw new Error('Клієнта не знайдено')
        if (Number(customer.bonus_balance ?? 0) < amount) throw new Error('Недостатньо бонусів у клієнта')
        bonusBalanceAfter = Number(customer.bonus_balance ?? 0) - amount
        this.db.prepare(`
          UPDATE customers SET bonus_balance = ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(bonusBalanceAfter, timestamp, timestamp, customer.id, tenantId)
        this.db.prepare(`
          INSERT INTO bonus_transactions (
            id, tenant_id, customer_id, amount, transaction_type, source_sale_id,
            description, created_by, dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'spend', NULL, ?, ?, ?, ?, ?)
        `).run(
          paymentId, tenantId, customer.id, -amount,
          input.notes ?? `Оплата замовлення #${order.order_number ?? order.id.slice(0, 8)} бонусами`,
          input.user_id ?? null, timestamp, timestamp, timestamp,
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
        bonus_balance_after: bonusBalanceAfter,
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
    /**
     * 25.11.2026 (рішення власника: «менеджер видає товар, клієнт оплачує на касі»; неоплачене одразу — борг):
     * видача без прийому грошей. Внесене за замовлення зараховується, решта — борг клієнта в тому ж чеку.
     * Менеджер без своєї зміни видає в межах відкритої зміни каси.
     */
    on_debt?: boolean
  } = {}): { data: { success: true; sale_id: string; sale_number: string; debt_amount?: number } } {
    return this.db.transaction(() => this.completeOrderInTransaction(orderId, input))
  }

  /**
   * 25.11.2026 (власник: «часть запчастей приехала, а часть нет, и клиент уже хочет забрать половину»):
   * часткова видача. Вибрані прибулі позиції лишаються в цьому замовленні й видаються (неоплачене — борг клієнта),
   * решта переходить у НОВЕ замовлення з тими самими позиціями (звʼязок із замовленням постачальнику й фото зберігаються).
   * Так у кожного замовлення, як і раніше, один чек видачі. Надлишок передоплати (внесли більше, ніж забирають) —
   * на рахунок клієнта (рішення власника: «или выдача с кассы, или остаться на счету по желанию клиента»).
   */
  handOverItems(orderId: string, input: { tenant_id?: string; user_id: string; item_ids: string[] }): {
    data: { success: true; sale_id: string; sale_number: string; debt_amount?: number; moved_to_account?: number; rest_order_id?: string; rest_order_number?: number }
  } {
    return this.db.transaction(() => {
      const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
      const order = this.getOrder(orderId, tenantId)
      if (!order) throw new Error('Замовлення не знайдено')
      if (TERMINAL_STATUSES.has(String(order.status)) || NON_ISSUEABLE.has(order.status)) throw new Error('Це замовлення вже закрите — видачу не проведено')
      const wanted = new Set((Array.isArray(input.item_ids) ? input.item_ids : []).map(String))
      const open = order.items.filter((item: any) => !['canceled', 'handed', 'returned'].includes(String(item.item_status)))
      const selected = open.filter((item: any) => wanted.has(String(item.id)))
      if (!selected.length || selected.length !== wanted.size) throw new Error('Виберіть позиції для видачі (вибрану позицію не знайдено або її вже видано)')
      const notArrived = selected.filter((item: any) => item.item_status !== 'arrived')
      if (notArrived.length) throw new Error(`Видати можна лише прибулі позиції. Ще не прибуло: ${notArrived.slice(0, 3).map((item: any) => `«${item.name || 'Без назви'}»`).join(', ')}`)
      const rest = open.filter((item: any) => !wanted.has(String(item.id)))
      // Усе, що лишилось, видається — звичайна видача (неоплачене — борг).
      if (!rest.length) return this.completeOrderInTransaction(orderId, { tenant_id: tenantId, user_id: input.user_id, on_debt: true })

      if (!order.customer_id) throw new Error('Частково видати можна лише замовлення з клієнтом. Виберіть клієнта в замовленні.')
      if (num(order.discount_amount) > 0) throw new Error('Замовлення має знижку на все замовлення — його видають повністю. Частково видати не можна.')
      const ledger = this.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS paid, COALESCE(SUM(CASE WHEN method = 'bonus' THEN amount ELSE 0 END), 0) AS bonus
        FROM order_payments WHERE tenant_id = ? AND order_id = ? AND deleted_at IS NULL`).get(tenantId, orderId) as { paid: number; bonus: number }
      if (num(ledger.bonus) > 0) throw new Error('Замовлення частково оплачене бонусами — його видають повністю. Частково видати не можна.')
      // Видача записується в зміну каси — перевіряємо до розділення, щоб не розділити замовлення даремно.
      if (!this.handoverShift(input.user_id, tenantId)) throw new Error('Касова зміна не відкрита. Видача записується в зміну каси — спочатку відкрийте зміну на касі.')

      const timestamp = this.nextTimestamp(tenantId, orderId)
      const lineTotal = (item: any) => Math.round(num(item.sell_price) * stockQuantity(item.qty)) + Math.round(num(item.core_deposit_amount) * stockQuantity(item.qty))
      const handedTotal = selected.reduce((sum: number, item: any) => sum + lineTotal(item), 0)
      const restTotal = rest.reduce((sum: number, item: any) => sum + lineTotal(item), 0)
      assertOrderTotal(handedTotal); assertOrderTotal(restTotal)

      // Нове замовлення для решти: той самий клієнт, менеджер, авто, коментар; грошей у ньому ще немає.
      const restId = randomUUID()
      const restNumber = this.nextOrderNumber(tenantId, timestamp)
      const restStatus = rest.every((item: any) => item.item_status === 'arrived') ? 'ready'
        : rest.some((item: any) => item.item_status === 'ordered' || item.item_status === 'arrived') ? 'ordered' : 'new'
      const sourceNumber = order.order_number ?? orderId.slice(0, 8)
      const restComment = [String(order.comment ?? '').trim(), `Залишок замовлення №${sourceNumber} (частину видано ${timestamp.slice(0, 10)})`].filter(Boolean).join('\n')
      this.db.prepare(`
        INSERT INTO customer_orders (
          id, tenant_id, order_number, kp_number, customer_id, chat_id, manager_id,
          vehicle_info_json, status, prepayment, prepayment_method,
          prepayment_is_fiscal, total_amount, total_paid, discount_amount,
          pickup_deadline_at, pickup_cell, comment, source, dirty_at, created_at, updated_at
        )
        SELECT ?, tenant_id, ?, NULL, customer_id, chat_id, manager_id,
          vehicle_info_json, ?, 0, NULL,
          0, ?, 0, 0,
          pickup_deadline_at, pickup_cell, ?, source, ?, ?, ?
        FROM customer_orders WHERE id = ? AND tenant_id = ?
      `).run(restId, restNumber, restStatus, restTotal, restComment, timestamp, timestamp, timestamp, orderId, tenantId)
      const moveItem = this.db.prepare(`UPDATE customer_order_items SET order_id = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND order_id = ? AND tenant_id = ? AND deleted_at IS NULL`)
      for (const item of rest) {
        if (Number(moveItem.run(restId, timestamp, timestamp, item.id, orderId, tenantId).changes) !== 1) throw new Error('Позицію замовлення не перенесено — видачу скасовано')
      }

      // Надлишок передоплати — на рахунок клієнта; у замовленні лишається рівно стільки, скільки коштує видане.
      const paid = Math.max(num(order.total_paid), num(order.prepayment), num(ledger.paid))
      const surplus = Math.max(0, paid - handedTotal)
      this.db.prepare(`UPDATE customer_orders SET total_amount = ?, status = 'ready', total_paid = ?, prepayment = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?`).run(handedTotal, paid - surplus, Math.min(num(order.prepayment), paid - surplus), timestamp, timestamp, orderId, tenantId)
      this.syncOrderReserves(orderId, tenantId)
      this.syncOrderReserves(restId, tenantId)

      // Спершу замовлення (сервер замінює позиції знімком: старе віддає перенесені позиції, нове їх приймає), потім гроші й видача.
      this.addOutbox(tenantId, 'customer_order', orderId, 'order.updated', this.getOrder(orderId, tenantId), timestamp)
      this.addOutbox(tenantId, 'customer_order', restId, 'order.created', this.getOrder(restId, tenantId), timestamp)
      if (surplus > 0) {
        const customer = this.db.prepare(`SELECT id, COALESCE(deposit_balance, 0) AS deposit_balance FROM customers
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1`).get(order.customer_id, tenantId) as { id: string; deposit_balance: number } | undefined
        if (!customer) throw new Error('Клієнта замовлення не знайдено — видачу не проведено')
        const balanceAfter = num(customer.deposit_balance) + surplus
        const transactionId = randomUUID()
        const notes = `Надлишок передоплати замовлення №${sourceNumber}: видано частину, решта — замовлення №${restNumber}`
        this.db.prepare('UPDATE customers SET deposit_balance = ?, dirty_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
          .run(balanceAfter, timestamp, timestamp, customer.id, tenantId)
        this.db.prepare(`INSERT INTO customer_deposit_transactions (
            id, tenant_id, customer_id, amount, balance_after, method, order_id, notes, created_by, dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'account', ?, ?, ?, ?, ?, ?)`)
          .run(transactionId, tenantId, customer.id, surplus, balanceAfter, orderId, notes, input.user_id, timestamp, timestamp, timestamp)
        this.addOutbox(tenantId, 'customer', customer.id, 'customer.deposit_changed', {
          customer_id: customer.id, transaction_id: transactionId, amount: surplus, method: 'account', order_id: orderId,
          notes, created_by: input.user_id, created_at: timestamp, balance_after: balanceAfter,
        }, timestamp)
      }
      const issued = this.completeOrderInTransaction(orderId, { tenant_id: tenantId, user_id: input.user_id, on_debt: true })
      return { data: { ...issued.data, moved_to_account: surplus, rest_order_id: restId, rest_order_number: restNumber } }
    })
  }

  /** Відкрита зміна для видачі: своя, а якщо її немає (менеджер) — найсвіжіша відкрита зміна каси. */
  private handoverShift(userId: string, tenantId: string): string | null {
    const own = this.pos.findOpenShift(userId, tenantId)
    if (own) return own
    const row = this.db.prepare(`SELECT id FROM shifts WHERE tenant_id = ? AND status = 'open' AND deleted_at IS NULL
      ORDER BY opened_at DESC LIMIT 1`).get(tenantId) as { id: string } | undefined
    return row?.id ?? null
  }

  private completeOrderInTransaction(orderId: string, input: NonNullable<Parameters<LocalOrderRepository['completeOrder']>[1]>): { data: { success: true; sale_id: string; sale_number: string; debt_amount?: number } } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const order = this.getOrder(orderId, tenantId)
    if (!order) throw new Error('Замовлення не знайдено')
    if (order.status === 'completed' && order.sale_id) {
      const existingSale = this.db.prepare(`
        SELECT id, sale_number, COALESCE(debt_amount, 0) AS debt_amount
        FROM sales
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        LIMIT 1
      `).get(order.sale_id, tenantId) as { id: string; sale_number: string; debt_amount: number } | undefined
      if (!existingSale) throw new Error('Замовлення позначене виданим, але пов’язаний чек відсутній')
      // Повтор того самого запиту відповідає так само, як перший раз (разом із боргом видачі).
      return {
        data: {
          success: true,
          sale_id: existingSale.id,
          sale_number: existingSale.sale_number,
          debt_amount: Number(existingSale.debt_amount),
        },
      }
    }
    if (NON_ISSUEABLE.has(order.status)) throw new Error('Це замовлення не можна видати через касу')
    if (input.is_fiscal) throw new Error('Фіскалізація видачі замовлення ще не підтримується цим каналом. Фіскальний чек не створено; видачу не проведено.')
    const onDebt = input.on_debt === true
    const remaining = this.remainingDue(order)
    if (remaining > 0 && !onDebt) throw new Error('Не всі оплати проведено')
    if (remaining > 0 && !order.customer_id) {
      throw new Error('Неоплачене замовлення можна видати в борг лише клієнту. Виберіть клієнта в замовленні або прийміть оплату.')
    }

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
    const shiftId = input.shift_id ?? (onDebt ? this.handoverShift(cashierId, tenantId) : this.pos.findOpenShift(cashierId, tenantId))
    if (!shiftId) throw new Error(onDebt ? 'Касова зміна не відкрита. Видача записується в зміну каси — спочатку відкрийте зміну на касі.' : 'Спочатку відкрийте касову зміну')
    // Видача без грошей (менеджер) може йти в чужу відкриту зміну каси; гроші — лише у свою.
    if (!this.db.prepare(`SELECT id FROM shifts WHERE id = ? AND tenant_id = ?
      AND (cashier_id = ? OR ?) AND status = 'open' AND deleted_at IS NULL`).get(shiftId, tenantId, cashierId, onDebt ? 1 : 0)) {
      throw new Error('Касову зміну закрито або вона належить іншому касиру')
    }
    const timestamp = this.nextTimestamp(tenantId, orderId)
    const saleId = randomUUID()
    const orderPayments = this.listPayments(orderId, tenantId)
    const paymentTotals = { cash: 0, card: 0, transfer: 0, bonus: 0 }
    for (const payment of orderPayments) {
      const amount = Math.max(0, Math.round(num(payment.amount)))
      if (payment.method === 'bonus') paymentTotals.bonus += amount
      else if (payment.method === 'card') paymentTotals.card += amount
      else if (payment.method === 'transfer' || payment.method === 'account') paymentTotals.transfer += amount
      else paymentTotals.cash += amount
    }
    // 25.11.2026: при частковій видачі надлишок передоплати переведено на рахунок клієнта (handOverItems) —
    // ці гроші вже не належать замовленню. Знімаємо їх із готівки, потім переказу, потім картки.
    let movedOut = Math.max(0, Math.round(num((this.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS amount FROM customer_deposit_transactions
      WHERE tenant_id = ? AND order_id = ? AND amount > 0 AND id <> ? AND deleted_at IS NULL`).get(tenantId, orderId, orderId) as { amount: number }).amount)))
    for (const kind of ['cash', 'transfer', 'card'] as const) {
      const take = Math.min(paymentTotals[kind], movedOut)
      paymentTotals[kind] -= take
      movedOut -= take
    }
    const listedPaid = paymentTotals.cash + paymentTotals.card + paymentTotals.transfer + paymentTotals.bonus
    const legacyPaid = Math.max(0, Math.round(Math.max(num(order.total_paid), num(order.prepayment))) - listedPaid)
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
    // A fiscal prepayment is not a fiscal receipt for this issue operation.
    const isFiscal = false

    return this.db.transaction(() => {
      const settingsRow = this.db.prepare(
        "SELECT value_json FROM app_meta WHERE key = 'shop_settings' LIMIT 1",
      ).get() as { value_json: string } | undefined
      let allowNegativeQty = false
      if (settingsRow?.value_json) {
        try {
          allowNegativeQty = JSON.parse(settingsRow.value_json)?.allow_negative_qty === true
        } catch {
          allowNegativeQty = false
        }
      }

      let subtotal = 0
      const requested = new Map<string, number>()
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

        const qty = stockQuantity(item.qty)
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
        const combinedQty = addStockQuantity(requested.get(product.id) ?? 0, qty)
        requested.set(product.id, combinedQty)
        if (product.is_service !== 1) {
          // 27.11.2026: власна бронь цього замовлення не заважає; чужу (інше замовлення, сайт) не віддаємо навіть у мінус.
          const problem = reservedStockProblem({ name: product.name, qtyOnHand: Number(product.qty_on_hand), requested: combinedQty, allowNegative: allowNegativeQty,
            holders: reserveHolders(this.db, tenantId, product.id, orderId) })
          if (problem) throw problem
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

      // Бонуси в чеку — як на касі: входять у знижку, гроші — лише готівка/картка/переказ.
      const bonusesSpent = paymentTotals.bonus
      const discount = Math.max(0, Math.round(num(order.discount_amount))) + bonusesSpent
      const total = Math.max(0, subtotal - discount)
      const paidForOrder = paymentTotals.cash + paymentTotals.card + paymentTotals.transfer
      // Неоплачена частина при видачі в борг (рішення власника 25.11.2026: одразу борг клієнта).
      let debtAmount = 0
      if (paidForOrder !== total) {
        const difference = Math.abs(paidForOrder - total)
        if (paidForOrder > total) {
          throw new Error(`Передоплата перевищує суму замовлення на ${(difference / 100).toFixed(2)} грн. Поверніть надлишок або зарахуйте його на рахунок клієнта.`)
        }
        if (!onDebt || !order.customer_id) throw new Error(`Не всі оплати проведено. Залишилось ${(difference / 100).toFixed(2)} грн.`)
        debtAmount = difference
      }
      const salePaymentMethod: 'cash' | 'card' | 'mixed' | 'transfer' | 'debt' = debtAmount === 0
        ? paymentMethod
        : paidForOrder === 0 ? 'debt' : 'mixed'
      const saleNumber = this.nextSaleNumber(tenantId, timestamp)
      const notes = `Видача замовлення #${order.order_number ?? order.id.slice(0, 8)}`
        + (debtAmount > 0 ? ` — у борг ${(debtAmount / 100).toFixed(2)} грн` : '')

      this.db.prepare(`
        INSERT INTO sales (
          id, tenant_id, sale_number, customer_id, cashier_id, manager_id, shift_id,
          status, subtotal, discount, total, payment_method, is_debt, is_fiscal,
          cash_amount, card_amount, transfer_amount, debt_amount, pickup_cell, notes,
          completed_at, dirty_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        salePaymentMethod,
        debtAmount > 0 ? 1 : 0,
        isFiscal ? 1 : 0,
        paymentTotals.cash,
        paymentTotals.card,
        paymentTotals.transfer,
        debtAmount,
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
          const current = this.db.prepare('SELECT qty_on_hand FROM products WHERE id = ? AND tenant_id = ?')
            .get(item.product_id, tenantId) as { qty_on_hand: number }
          const qtyAfter = subtractStockQuantity(current.qty_on_hand, item.qty)
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
        SET released_at = ?, dirty_at = ?, updated_at = ?
        WHERE tenant_id = ? AND order_id = ? AND released_at IS NULL AND deleted_at IS NULL
      `).run(timestamp, timestamp, timestamp, tenantId, orderId)

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

      if (debtAmount > 0) {
        const customer = this.db.prepare(`SELECT COALESCE(debt_balance, 0) AS debt_balance FROM customers
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1`).get(order.customer_id, tenantId) as { debt_balance: number } | undefined
        if (!customer) throw new Error('Клієнта замовлення не знайдено — видачу в борг не проведено')
        const debtAfter = Number(customer.debt_balance ?? 0) + debtAmount
        if (!Number.isSafeInteger(debtAfter)) throw new Error('Борг клієнта завеликий')
        this.db.prepare(`UPDATE customers SET debt_balance = ?, dirty_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`)
          .run(debtAfter, timestamp, timestamp, order.customer_id, tenantId)
      }

      const syncItems = preparedItems.map(({ qty_on_hand: _qtyOnHand, ...item }: any) => item)
      this.addOutbox(tenantId, 'customer_order', orderId, 'order.completed', {
        order_id: orderId,
        sale_id: saleId,
        sale_number: saleNumber,
        shift_id: shiftId,
        cashier_id: cashierId,
        customer_id: order.customer_id ?? null,
        manager_id: order.manager_id ?? cashierId,
        payment_method: salePaymentMethod,
        is_fiscal: isFiscal,
        subtotal,
        discount,
        total,
        cash_amount: paymentTotals.cash,
        card_amount: paymentTotals.card,
        transfer_amount: paymentTotals.transfer,
        bonuses_spent: bonusesSpent,
        debt_amount: debtAmount,
        is_debt: debtAmount > 0,
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
          payment_method: salePaymentMethod,
          is_fiscal: isFiscal,
          subtotal,
          discount,
          total,
          cash_amount: paymentTotals.cash,
          card_amount: paymentTotals.card,
          transfer_amount: paymentTotals.transfer,
          bonuses_spent: bonusesSpent,
          debt_amount: debtAmount,
        is_debt: debtAmount > 0,
          pickup_cell: order.pickup_cell ?? null,
          notes,
          completed_at: timestamp,
          items: syncItems,
        },
      }, timestamp)

      // The issue, stock movement and payroll accrual must commit together.
      new LocalStaffRepository(this.db).recordOrderCommissions(orderId, tenantId, cashierId)
      return { data: { success: true as const, sale_id: saleId, sale_number: saleNumber, debt_amount: debtAmount } }
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
  private decorateOrders(rows: any[], tenantId: string): any[] {
    if (!rows.length) return []
    const items = this.db.prepare(`
      SELECT * FROM customer_order_items
      WHERE tenant_id = ? AND order_id IN (${rows.map(() => '?').join(',')}) AND deleted_at IS NULL
      ORDER BY created_at ASC, rowid ASC
    `).all(tenantId, ...rows.map((row) => row.id)) as any[]
    const byOrder = new Map<string, any[]>()
    for (const item of items) {
      const group = byOrder.get(item.order_id) ?? []
      group.push(item)
      byOrder.set(item.order_id, group)
    }
    return rows.map((row) => this.decorateOrder(row, tenantId, byOrder.get(row.id) ?? []))
  }

  private isNotebookOrder(orderId: string, tenantId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM app_meta WHERE key = ?').get(notebookOrderKey(tenantId, orderId)))
  }

  private decorateOrder(row: any, tenantId: string, loadedItems?: any[]): any {
    const items = loadedItems ?? this.db.prepare(`
      SELECT * FROM customer_order_items
      WHERE tenant_id = ? AND order_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC, rowid ASC
    `).all(tenantId, row.id) as any[]
    return {
      id: row.id,
      // Список бере позначку тим самим запитом (без окремого читання на кожне замовлення).
      from_notebook: row.from_notebook !== undefined ? Number(row.from_notebook) === 1 : this.isNotebookOrder(row.id, tenantId),
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
        bonus_balance: num(row.customer_bonus_balance),
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
    return Math.max(0, num(order.total_amount) - num(order.discount_amount) - Math.max(num(order.total_paid), num(order.prepayment)))
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
