import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'
import { idempotentMutation } from './idempotentMutation'
import { normalizeSearchText } from './catalogRepository'

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
    operation_id?: string
    tenant_id?: string
    product_id: string
    qty: number
    from_bin?: string | null
    to_bin: string
    note?: string | null
    user_id?: string | null
  }): any {
    return this.db.transaction(() => input.operation_id
      ? idempotentMutation(this.db, 'movement:' + (input.tenant_id ?? DEFAULT_TENANT_ID), input.operation_id, input, () => this.createMovementInTransaction(input))
      : this.createMovementInTransaction(input))
  }

  private createMovementInTransaction(input: Parameters<LocalWarehouseRepository['createMovement']>[0]): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const qty = numberValue(input.qty)
    const toBin = String(input.to_bin ?? '').trim()
    if (qty <= 0) throw new Error('Кількість має бути більше нуля')
    if (!toBin) throw new Error('Вкажіть нову комірку')
    const product = this.product(input.product_id, tenantId)
    if (qty > numberValue(product.qty_on_hand)) throw new Error('Кількість переміщення перевищує залишок товару')
    if (qty !== numberValue(product.qty_on_hand)) throw new Error('Товар має одну комірку: перемістіть увесь залишок. Часткове переміщення не підтримується.')
    const fromBin = String(product.storage_bin ?? '').trim() || null
    if (input.from_bin !== undefined && (String(input.from_bin ?? '').trim() || null) !== fromBin) throw new Error('Комірка товару вже змінилася. Знайдіть товар повторно.')
    if (toBin === fromBin) throw new Error('Товар уже знаходиться в цій комірці')
    const barcodes = this.db.prepare('SELECT barcode FROM product_barcodes WHERE product_id = ? AND tenant_id = ? AND deleted_at IS NULL').all(product.id, tenantId) as Array<{ barcode: string }>
    const searchText = normalizeSearchText([product.sku, product.name, product.barcode, toBin, ...barcodes.map(row => row.barcode)].filter(Boolean).join(' '))
    const timestamp = nowIso()
    const id = randomUUID()
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO warehouse_movements (
          id, tenant_id, product_id, from_bin, to_bin, qty, note, created_by,
          dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, tenantId, product.id, fromBin,
        toBin, qty, input.note ?? null, input.user_id ?? null,
        timestamp, timestamp, timestamp,
      )
      this.db.prepare(`
        UPDATE products
        SET storage_bin = ?, search_text = ?,
            dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(toBin, searchText, timestamp, timestamp, product.id, tenantId)
      this.addOutbox(tenantId, 'warehouse_movement', id, 'warehouse_movement.created', {
        id,
        product_id: product.id,
        from_bin: fromBin,
        to_bin: toBin,
        qty,
        note: input.note ?? null,
      }, timestamp)
      this.addOutbox(tenantId, 'product', product.id, 'product.upsert', {
        id: product.id,
        storage_bin: toBin,
      }, timestamp)
    })
    return { id, product_id: product.id, product_name: product.name, product_sku: product.sku, from_bin: fromBin, to_bin: toBin, qty, note: input.note ?? null, created_at: timestamp }
  }

  listReserves(tenantId = DEFAULT_TENANT_ID): any[] {
    return this.db.prepare(`
      SELECT r.id, r.tenant_id, r.product_id, r.order_id, r.customer_id, r.qty,
             r.reserved_by, r.expires_at, r.released_at, r.created_at,
             p.name AS product_name, p.sku AS product_sku,
             c.full_name AS customer_name, c.phone AS customer_phone,
             o.order_number, o.status AS order_status, u.full_name AS reserved_name
      FROM stock_reserves r
      JOIN products p ON p.id = r.product_id
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN customer_orders o ON o.id = r.order_id
      LEFT JOIN staff_users u ON u.id = r.reserved_by AND u.tenant_id = r.tenant_id
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
      user: row.reserved_by ? { id: row.reserved_by, full_name: row.reserved_name ?? 'Працівник' } : null,
    }))
  }

  createReserve(input: {
    operation_id?: string
    tenant_id?: string
    product_id: string
    qty: number
    customer_id?: string | null
    order_id?: string | null
    expires_at?: string | null
    user_id?: string | null
  }): any {
    return this.db.transaction(() => input.operation_id
      ? idempotentMutation(this.db, 'reserve:' + (input.tenant_id ?? DEFAULT_TENANT_ID), input.operation_id, input, () => this.createReserveInTransaction(input))
      : this.createReserveInTransaction(input))
  }

  createManualReserve(input: Parameters<LocalWarehouseRepository['createReserve']>[0]): any {
    if (input.order_id) throw new Error('Резерв замовлення створюється тільки з картки замовлення')
    return this.createReserve(input)
  }

  releaseManualReserve(id: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT order_id FROM stock_reserves WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(id, tenantId) as { order_id: string | null } | undefined
      if (row?.order_id) throw new Error('Резерв пов’язаний із замовленням. Змініть або скасуйте позицію в замовленні.')
      return this.releaseReserve(id, tenantId)
    })
  }

  private createReserveInTransaction(input: Parameters<LocalWarehouseRepository['createReserve']>[0]): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const qty = numberValue(input.qty)
    if (qty <= 0) throw new Error('Кількість резерву має бути більше нуля')
    let expiresAt: string | null = null
    if (input.expires_at) {
      const expires = new Date(input.expires_at)
      if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now()) throw new Error('Термін резерву має бути в майбутньому')
      expiresAt = expires.toISOString()
    }
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
      qty, input.user_id ?? null, expiresAt, timestamp, timestamp, timestamp,
    )
    this.addOutbox(tenantId, 'stock_reserve', id, 'reserve.created', {
      id,
      product_id: product.id,
      order_id: input.order_id ?? null,
      customer_id: input.customer_id ?? null,
      qty,
      expires_at: expiresAt,
    }, timestamp)
    return this.listReserves(tenantId).find((reserve) => reserve.id === id)
  }

  releaseReserve(id: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    return this.db.transaction(() => this.releaseReserveInTransaction(id, tenantId))
  }

  private releaseReserveInTransaction(id: string, tenantId: string): { ok: true } {
    const existing = this.db.prepare('SELECT released_at FROM stock_reserves WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(id, tenantId) as { released_at: string | null } | undefined
    if (existing?.released_at) return { ok: true }
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
    operation_id?: string
    tenant_id?: string
    reason: string
    notes?: string | null
    user_id?: string | null
    items: Array<{ product_id: string; qty: number }>
  }): any {
    if (input.operation_id) return idempotentMutation(this.db, 'writeoff:' + (input.tenant_id ?? DEFAULT_TENANT_ID), input.operation_id, input, () => this.createWriteoff({ ...input, operation_id: undefined }))
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
          Math.round(numberValue(item.product.purchase_price) * item.qty), timestamp, timestamp,
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
    // All document writes resolve the current authoritative catalog row.
    const product = this.db.prepare(`
      SELECT id, name, sku, barcode, unit, purchase_price, qty_on_hand, storage_bin
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

  listConsumptions(input: { month: string; tenant_id?: string }): any {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw new Error('Вкажіть коректний місяць')
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const rows = this.db.prepare(`SELECT * FROM internal_consumptions
      WHERE tenant_id = ? AND business_date >= ? AND business_date <= ? ORDER BY created_at DESC, id DESC`)
      .all(tenantId, input.month + '-01', input.month + '-31') as any[]
    const summary = new Map<string, any>()
    const data = rows.map(({ items_json, ...row }) => ({ ...row, items: JSON.parse(items_json) }))
    for (const row of data) {
      const entry = summary.get(row.employee_id) ?? { employee_id: row.employee_id, employee_name: row.employee_name, total_cost: 0, items_count: 0 }
      entry.total_cost += row.total_cost
      entry.items_count += row.items.reduce((sum: number, item: any) => sum + item.qty, 0)
      summary.set(row.employee_id, entry)
    }
    const employees = this.db.prepare('SELECT id, full_name, role FROM staff_users WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL ORDER BY full_name, id').all(tenantId)
    return { data, summary: [...summary.values()], employees }
  }

  createConsumption(input: { operation_id?: string; tenant_id?: string; employee_id: string; items: Array<{ product_id: string; qty: number }>; note?: string | null; user_id?: string | null }): any {
    if (input.operation_id) return idempotentMutation(this.db, 'consumption:' + (input.tenant_id ?? DEFAULT_TENANT_ID), input.operation_id, input,
      () => this.createConsumption({ ...input, operation_id: undefined }))
    return this.db.transaction(() => {
      const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
      const employee = this.db.prepare('SELECT id, full_name FROM staff_users WHERE id = ? AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL').get(input.employee_id, tenantId) as { id: string; full_name: string } | undefined
      if (!employee) throw new Error('Активного працівника не знайдено')
      if (!Array.isArray(input.items) || !input.items.length) throw new Error('Додайте товари для відпуску')
      const items = input.items.map(item => {
        const product = this.product(item.product_id, tenantId)
        const qty = Number(item.qty)
        if (!Number.isFinite(qty) || qty <= 0) throw new Error('Вкажіть додатну кількість')
        const reserved = this.db.prepare(`SELECT COALESCE(SUM(qty), 0) qty FROM stock_reserves WHERE tenant_id = ? AND product_id = ? AND deleted_at IS NULL AND released_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
          .get(tenantId, product.id, nowIso()) as { qty: number }
        if (qty > Number(product.qty_on_hand) - Number(reserved.qty)) throw new Error('Недостатньо вільного товару: ' + product.name)
        const total = Math.round(Number(product.purchase_price) * qty)
        if (!Number.isSafeInteger(total) || total < 0) throw new Error('Некоректна собівартість товару')
        return { product_id: product.id, product_name: product.name, sku: product.sku, qty, buy_price: Number(product.purchase_price), total }
      })
      const totalCost = items.reduce((sum, item) => sum + item.total, 0)
      if (!Number.isSafeInteger(totalCost)) throw new Error('Надто велика сума документа')
      const note = String(input.note ?? '').trim() || null
      const writeoff = this.createWriteoff({ tenant_id: tenantId, reason: 'other', user_id: input.user_id,
        notes: `Для потреб магазину — ${employee.full_name}${note ? ': ' + note : ''}`, items })
      const timestamp = nowIso()
      const businessDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp))
      const row = { id: randomUUID(), employee_id: employee.id, employee_name: employee.full_name, writeoff_id: writeoff.id, items, total_cost: totalCost, note, created_at: timestamp }
      this.db.prepare(`INSERT INTO internal_consumptions (id, tenant_id, employee_id, employee_name, writeoff_id, items_json, total_cost, note, business_date, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.id, tenantId, employee.id, employee.full_name, writeoff.id, JSON.stringify(items), totalCost, note, businessDate, input.user_id ?? null, timestamp)
      return row
    })
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
