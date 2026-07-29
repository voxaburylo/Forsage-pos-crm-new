import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'

function nowIso(): string {
  return new Date().toISOString()
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export class LocalWarehouseRepository {
  constructor(private readonly db: LocalDatabase) {}

  listMovements(input: { tenant_id?: string; page?: number; per_page?: number } = {}): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const page = Math.max(1, Number(input.page ?? 1))
    const perPage = Math.max(1, Math.min(200, Number(input.per_page ?? 20)))
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM warehouse_movements
      WHERE tenant_id = ? AND deleted_at IS NULL
    `).get(tenantId) as { count: number }
    const data = this.db.prepare(`
      SELECT m.id, m.product_id, m.from_bin, m.to_bin, m.qty, m.note, m.created_at,
             p.name AS product_name, p.sku AS product_sku
      FROM warehouse_movements m
      JOIN products p ON p.id = m.product_id
      WHERE m.tenant_id = ? AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `).all(tenantId, perPage, (page - 1) * perPage) as any[]
    const total = numberValue(totalRow.count)
    return {
      data,
      pagination: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
    }
  }

  createMovement(input: {
    tenant_id?: string
    product_id: string
    qty: number
    from_bin?: string | null
    to_bin: string
    note?: string | null
    user_id?: string | null
  }): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const qty = numberValue(input.qty)
    const toBin = String(input.to_bin ?? '').trim()
    if (qty <= 0) throw new Error('Кількість має бути більше нуля')
    if (!toBin) throw new Error('Вкажіть нову комірку')
    const product = this.product(input.product_id, tenantId)
    if (qty > numberValue(product.qty_on_hand)) throw new Error('Кількість переміщення перевищує залишок товару')
    const timestamp = nowIso()
    const id = randomUUID()
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO warehouse_movements (
          id, tenant_id, product_id, from_bin, to_bin, qty, note, created_by,
          dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, tenantId, product.id, input.from_bin ?? product.storage_bin ?? null,
        toBin, qty, input.note ?? null, input.user_id ?? null,
        timestamp, timestamp, timestamp,
      )
      this.db.prepare(`
        UPDATE products
        SET storage_bin = ?, search_text = trim(search_text || ' ' || ?),
            dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(toBin, toBin.toLocaleLowerCase('uk-UA'), timestamp, timestamp, product.id, tenantId)
      this.addOutbox(tenantId, 'warehouse_movement', id, 'warehouse_movement.created', {
        id,
        product_id: product.id,
        from_bin: input.from_bin ?? product.storage_bin ?? null,
        to_bin: toBin,
        qty,
        note: input.note ?? null,
      }, timestamp)
      this.addOutbox(tenantId, 'product', product.id, 'product.upsert', {
        id: product.id,
        storage_bin: toBin,
      }, timestamp)
    })
    return this.listMovements({ tenant_id: tenantId, page: 1, per_page: 1 }).data[0]
  }

  listReserves(tenantId = DEFAULT_TENANT_ID): any[] {
    return this.db.prepare(`
      SELECT r.id, r.tenant_id, r.product_id, r.order_id, r.customer_id, r.qty,
             r.reserved_by, r.expires_at, r.released_at, r.created_at,
             p.name AS product_name, p.sku AS product_sku,
             c.full_name AS customer_name, c.phone AS customer_phone,
             o.order_number, o.status AS order_status
      FROM stock_reserves r
      JOIN products p ON p.id = r.product_id
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN customer_orders o ON o.id = r.order_id
      WHERE r.tenant_id = ? AND r.deleted_at IS NULL AND r.released_at IS NULL
      ORDER BY r.created_at DESC
    `).all(tenantId).map((row: any) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      product_id: row.product_id,
      order_id: row.order_id,
      customer_id: row.customer_id,
      qty: numberValue(row.qty),
      reserved_by: row.reserved_by,
      expires_at: row.expires_at,
      released_at: row.released_at,
      created_at: row.created_at,
      product: { id: row.product_id, name: row.product_name, sku: row.product_sku },
      customer: row.customer_id ? { id: row.customer_id, full_name: row.customer_name, phone: row.customer_phone } : null,
      order: row.order_id ? { id: row.order_id, number: String(row.order_number ?? ''), status: row.order_status } : null,
      user: null,
    }))
  }

  createReserve(input: {
    tenant_id?: string
    product_id: string
    qty: number
    customer_id?: string | null
    order_id?: string | null
    expires_at?: string | null
    user_id?: string | null
  }): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const qty = numberValue(input.qty)
    if (qty <= 0) throw new Error('Кількість резерву має бути більше нуля')
    const product = this.product(input.product_id, tenantId)
    const reservedRow = this.db.prepare(`
      SELECT COALESCE(SUM(qty), 0) AS qty
      FROM stock_reserves
      WHERE tenant_id = ? AND product_id = ? AND released_at IS NULL
        AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    `).get(tenantId, product.id, nowIso()) as { qty: number }
    const available = numberValue(product.qty_on_hand) - numberValue(reservedRow.qty)
    if (qty > available) throw new Error('Недостатньо доступного товару для резерву')
    if (input.customer_id) this.requireExisting('customers', input.customer_id, tenantId, 'Клієнта не знайдено')
    if (input.order_id) this.requireExisting('customer_orders', input.order_id, tenantId, 'Замовлення не знайдено')
    const timestamp = nowIso()
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO stock_reserves (
        id, tenant_id, product_id, order_id, customer_id, qty, reserved_by,
        expires_at, dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, tenantId, product.id, input.order_id ?? null, input.customer_id ?? null,
      qty, input.user_id ?? null, input.expires_at ?? null, timestamp, timestamp, timestamp,
    )
    this.addOutbox(tenantId, 'stock_reserve', id, 'reserve.created', {
      id,
      product_id: product.id,
      order_id: input.order_id ?? null,
      customer_id: input.customer_id ?? null,
      qty,
      expires_at: input.expires_at ?? null,
    }, timestamp)
    return this.listReserves(tenantId).find((reserve) => reserve.id === id)
  }

  releaseReserve(id: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const timestamp = nowIso()
    const result = this.db.prepare(`
      UPDATE stock_reserves
      SET released_at = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND released_at IS NULL AND deleted_at IS NULL
    `).run(timestamp, timestamp, timestamp, id, tenantId)
    if (Number(result.changes) === 0) throw new Error('Активний резерв не знайдено')
    this.addOutbox(tenantId, 'stock_reserve', id, 'reserve.released', { id, released_at: timestamp }, timestamp)
    return { ok: true }
  }

  listWriteoffs(input: { tenant_id?: string; reason?: string; page?: number; per_page?: number } = {}): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const page = Math.max(1, Number(input.page ?? 1))
    const perPage = Math.max(1, Math.min(200, Number(input.per_page ?? 20)))
    const params: Array<string | number | null> = [tenantId]
    const reasonWhere = input.reason ? ' AND w.reason = ?' : ''
    if (input.reason) params.push(input.reason)
    const count = this.db.prepare(
      'SELECT COUNT(*) AS count FROM writeoffs w WHERE w.tenant_id = ? AND w.deleted_at IS NULL' + reasonWhere,
    ).get(...params) as { count: number }
    const rows = this.db.prepare(`
      SELECT w.id, w.tenant_id, w.reason, w.notes, w.created_by, w.created_at
      FROM writeoffs w
      WHERE w.tenant_id = ? AND w.deleted_at IS NULL
    ` + reasonWhere + ' ORDER BY w.created_at DESC LIMIT ? OFFSET ?')
      .all(...params, perPage, (page - 1) * perPage) as any[]
    const total = numberValue(count.count)
    return {
      data: rows.map((row) => ({ ...row, items: this.listWriteoffItems(row.id, tenantId) })),
      pagination: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
    }
  }

  private listWriteoffItems(writeoffId: string, tenantId: string): any[] {
    return this.db.prepare(`
      SELECT i.id, i.writeoff_id, i.product_id, i.qty, i.cost_kopecks, i.created_at,
             p.sku AS product_sku, p.name AS product_name, p.unit AS product_unit
      FROM writeoff_items i
      JOIN products p ON p.id = i.product_id
      WHERE i.writeoff_id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL
      ORDER BY i.created_at
    `).all(writeoffId, tenantId).map((item: any) => ({
      id: item.id,
      writeoff_id: item.writeoff_id,
      product_id: item.product_id,
      qty: numberValue(item.qty),
      cost_kopecks: numberValue(item.cost_kopecks),
      created_at: item.created_at,
      product: {
        id: item.product_id,
        sku: item.product_sku,
        name: item.product_name,
        unit: item.product_unit,
      },
    }))
  }

  getWriteoff(id: string, tenantId = DEFAULT_TENANT_ID): any {
    const row = this.db.prepare(`
      SELECT id, tenant_id, reason, notes, created_by, created_at
      FROM writeoffs
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(id, tenantId) as any
    if (!row) throw new Error('Списання не знайдено')
    row.items = this.listWriteoffItems(id, tenantId)
    return row
  }

  createWriteoff(input: {
    tenant_id?: string
    reason: string
    notes?: string | null
    user_id?: string | null
    items: Array<{ product_id: string; qty: number }>
  }): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('Додайте товари для списання')
    const uniqueProducts = new Set(input.items.map((item) => item.product_id))
    if (uniqueProducts.size !== input.items.length) throw new Error('Один товар не можна додавати до акта списання кілька разів')
    const prepared = input.items.map((item) => {
      const product = this.product(item.product_id, tenantId)
      const qty = numberValue(item.qty)
      if (qty <= 0) throw new Error('Кількість списання має бути більше нуля')
      if (qty > numberValue(product.qty_on_hand)) throw new Error('Недостатньо товару для списання: ' + product.name)
      return { product, qty, id: randomUUID() }
    })
    const timestamp = nowIso()
    const id = randomUUID()
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO writeoffs (
          id, tenant_id, reason, notes, created_by, dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, tenantId, input.reason, input.notes ?? null, input.user_id ?? null, timestamp, timestamp, timestamp)
      for (const item of prepared) {
        const nextQty = numberValue(item.product.qty_on_hand) - item.qty
        this.db.prepare(`
          INSERT INTO writeoff_items (
            id, tenant_id, writeoff_id, product_id, qty, cost_kopecks, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id, tenantId, id, item.product.id, item.qty,
          numberValue(item.product.purchase_price) * item.qty, timestamp, timestamp,
        )
        this.db.prepare(`
          UPDATE products SET qty_on_hand = ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(nextQty, timestamp, timestamp, item.product.id, tenantId)
        this.db.prepare(`
          INSERT INTO inventory_movements (
            id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
            unit_cost, notes, dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'writeoff', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), tenantId, item.product.id, id, -item.qty, nextQty,
          numberValue(item.product.purchase_price), input.notes ?? input.reason,
          timestamp, timestamp, timestamp,
        )
      }
      this.addOutbox(tenantId, 'writeoff', id, 'writeoff.created', {
        id,
        reason: input.reason,
        notes: input.notes ?? null,
        items: prepared.map((item) => ({ product_id: item.product.id, qty: item.qty })),
      }, timestamp)
    })
    return this.getWriteoff(id, tenantId)
  }

  private product(id: string, tenantId: string): any {
    const product = this.db.prepare(`
      SELECT id, name, sku, unit, purchase_price, qty_on_hand, storage_bin
      FROM products
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(id, tenantId) as any
    if (!product) throw new Error('Товар не знайдено')
    return product
  }

  private requireExisting(table: 'customers' | 'customer_orders', id: string, tenantId: string, message: string): void {
    const row = this.db.prepare('SELECT id FROM ' + table + ' WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1')
      .get(id, tenantId)
    if (!row) throw new Error(message)
  }

  private addOutbox(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    operationType: string,
    payload: unknown,
    timestamp: string,
  ): void {
    this.db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      randomUUID(), tenantId, this.db.deviceId, aggregateType, aggregateId,
      operationType, JSON.stringify(payload), timestamp,
    )
  }
}
