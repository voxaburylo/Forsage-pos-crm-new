import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'

function nowIso(): string {
  return new Date().toISOString()
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function boolInt(value: unknown): number {
  return value === true || value === 1 ? 1 : 0
}

interface InventoryCountInput {
  tenant_id?: string
  user_id?: string
  product_id: string
  qty: number
  price_checked?: boolean
  observed_retail_price?: number | null
}

export class LocalInventoryRepository {
  constructor(private readonly db: LocalDatabase) {}

  listSessions(tenantId = DEFAULT_TENANT_ID): any[] {
    return this.db.prepare(`
      SELECT id, tenant_id, session_name AS name, status, started_by AS created_by,
             created_at, completed_at
      FROM inventory_sessions
      WHERE tenant_id = ? AND deleted_at IS NULL AND status <> 'cancelled'
      ORDER BY created_at DESC
      LIMIT 50
    `).all(tenantId) as any[]
  }

  createSession(input: { tenant_id?: string; name: string; created_by?: string | null; created_at?: string | null }): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const timestamp = input.created_at || nowIso()
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO inventory_sessions (
        id, tenant_id, session_name, status, started_by, dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(id, tenantId, input.name.trim(), input.created_by ?? null, timestamp, timestamp, timestamp)
    return this.getSessionRow(id, tenantId)
  }

  startSession(sessionId: string, input: { tenant_id?: string; user_id?: string | null } = {}): { total_products: number } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const timestamp = nowIso()
    const row = this.getSessionRow(sessionId, tenantId)
    if (!row) throw new Error('Ревізію не знайдено')
    if (row.status === 'completed') throw new Error('Ревізію вже завершено')
    this.db.prepare(`
      UPDATE inventory_sessions
      SET status = 'in_progress', started_by = COALESCE(started_by, ?), started_at = COALESCE(started_at, ?),
          dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(input.user_id ?? null, timestamp, timestamp, timestamp, sessionId, tenantId)
    return { total_products: this.totalProducts(tenantId) }
  }

  deleteEmptySession(sessionId: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const row = this.getSessionRow(sessionId, tenantId)
    if (!row) return { ok: true }
    if (row.status === 'completed') throw new Error('Завершену ревізію видаляти не можна')
    const counted = this.db.prepare(`
      SELECT COUNT(*) AS count FROM inventory_items
      WHERE session_id = ? AND tenant_id = ? AND was_counted = 1 AND deleted_at IS NULL
    `).get(sessionId, tenantId) as { count: number }
    const entries = this.db.prepare(`
      SELECT COUNT(*) AS count FROM inventory_count_entries
      WHERE session_id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).get(sessionId, tenantId) as { count: number }
    if (num(counted.count) > 0 || num(entries.count) > 0) {
      throw new Error('Видаляти можна тільки порожні незавершені ревізії')
    }
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM inventory_count_entries WHERE session_id = ? AND tenant_id = ?').run(sessionId, tenantId)
      this.db.prepare('DELETE FROM inventory_items WHERE session_id = ? AND tenant_id = ?').run(sessionId, tenantId)
      this.db.prepare('DELETE FROM inventory_sessions WHERE id = ? AND tenant_id = ?').run(sessionId, tenantId)
    })
    return { ok: true }
  }

  getSessionData(sessionId: string, tenantId = DEFAULT_TENANT_ID, userId = ''): any {
    const session = this.getSessionRow(sessionId, tenantId)
    if (!session) throw new Error('Ревізію не знайдено')
    return {
      ...session,
      items: this.listCountedItems(sessionId, tenantId, 100),
      price_issues: this.listPriceIssues(sessionId, tenantId),
      my_entries: this.listEntries(sessionId, tenantId, userId),
      summary: this.summary(sessionId, tenantId),
    }
  }

  getLabels(sessionId: string, tenantId = DEFAULT_TENANT_ID): any[] {
    this.requireSession(sessionId, tenantId)
    return this.listCountedItems(sessionId, tenantId, 10000)
      .filter((item) => num(item.counted_stock) > 0)
  }

  findProduct(sessionId: string, input: { tenant_id?: string; code?: string; product_id?: string }): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    this.requireActiveSession(sessionId, tenantId)
    const product = input.product_id
      ? this.findProductById(input.product_id, tenantId)
      : this.findProductByCode(input.code ?? '', tenantId)
    if (!product) throw new Error('Товар не знайдено')
    const item = this.findItemByProduct(sessionId, product.id, tenantId)
    return { ...product, inventory_item: item }
  }

  countProduct(sessionId: string, input: InventoryCountInput): { data: any; session: any } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const userId = input.user_id ?? ''
    this.requireActiveSession(sessionId, tenantId)
    const product = this.findProductById(input.product_id, tenantId)
    if (!product) throw new Error('Товар не знайдено')
    const qty = num(input.qty)
    if (qty < 0) throw new Error('Некоректна кількість')
    const timestamp = nowIso()
    let itemId = ''
    this.db.transaction(() => {
      const existing = this.findItemByProduct(sessionId, product.id, tenantId)
      itemId = existing?.id ?? randomUUID()
      const nextQty = num(existing?.counted_stock) + qty
      this.db.prepare(`
        INSERT INTO inventory_items (
          id, tenant_id, session_id, product_id, expected_stock, counted_stock, was_counted,
          price_checked, observed_retail_price, last_counted_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, product_id) DO UPDATE SET
          counted_stock = excluded.counted_stock,
          was_counted = excluded.was_counted,
          price_checked = excluded.price_checked,
          observed_retail_price = excluded.observed_retail_price,
          last_counted_by = excluded.last_counted_by,
          updated_at = excluded.updated_at,
          deleted_at = NULL
      `).run(
        itemId,
        tenantId,
        sessionId,
        product.id,
        num(product.qty_on_hand),
        nextQty,
        1,
        boolInt(input.price_checked),
        input.observed_retail_price ?? null,
        userId || null,
        timestamp,
        timestamp,
      )
      this.db.prepare(`
        INSERT INTO inventory_count_entries (
          id, tenant_id, session_id, inventory_item_id, product_id, counted_by,
          qty, price_checked, observed_retail_price, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), tenantId, sessionId, itemId, product.id, userId || 'local', qty, boolInt(input.price_checked), input.observed_retail_price ?? null, timestamp)
      this.touchSession(sessionId, tenantId, timestamp)
    })
    return { data: { item_id: itemId }, session: this.getSessionData(sessionId, tenantId, userId) }
  }

  scan(sessionId: string, input: { tenant_id?: string; user_id?: string; barcode?: string; product_id?: string; qty?: number }): { item: any } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const userId = input.user_id ?? ''
    this.requireActiveSession(sessionId, tenantId)
    const qty = Math.max(1, Math.floor(num(input.qty) || 1))
    const product = input.product_id
      ? this.findProductById(input.product_id, tenantId)
      : this.findProductByCode(input.barcode ?? '', tenantId)
    if (!product) throw new Error('Товар не знайдено')

    const timestamp = nowIso()
    let itemId = ''
    this.db.transaction(() => {
      const existing = this.findItemByProduct(sessionId, product.id, tenantId)
      itemId = existing?.id ?? randomUUID()
      const nextQty = num(existing?.counted_stock) + qty
      this.db.prepare(`
        INSERT INTO inventory_items (
          id, tenant_id, session_id, product_id, expected_stock, counted_stock, was_counted,
          price_checked, observed_retail_price, last_counted_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, NULL, ?, ?, ?)
        ON CONFLICT(session_id, product_id) DO UPDATE SET
          counted_stock = excluded.counted_stock,
          was_counted = 1,
          price_checked = 1,
          observed_retail_price = NULL,
          last_counted_by = excluded.last_counted_by,
          updated_at = excluded.updated_at,
          deleted_at = NULL
      `).run(
        itemId,
        tenantId,
        sessionId,
        product.id,
        num(product.qty_on_hand),
        nextQty,
        userId || null,
        timestamp,
        timestamp,
      )
      this.db.prepare(`
        INSERT INTO inventory_count_entries (
          id, tenant_id, session_id, inventory_item_id, product_id, counted_by,
          qty, price_checked, observed_retail_price, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)
      `).run(randomUUID(), tenantId, sessionId, itemId, product.id, userId || 'local', qty, timestamp)
      this.touchSession(sessionId, tenantId, timestamp)
    })

    const item = this.findItemByProduct(sessionId, product.id, tenantId)
    return { item: this.decorateItem(item, tenantId) }
  }

  setItemQty(sessionId: string, itemId: string, input: { tenant_id?: string; counted_stock: number }): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    this.requireActiveSession(sessionId, tenantId)
    const qty = num(input.counted_stock)
    if (qty < 0) throw new Error('Некоректна кількість')
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE inventory_items
      SET counted_stock = ?, was_counted = 1, updated_at = ?, deleted_at = NULL
      WHERE id = ? AND session_id = ? AND tenant_id = ?
    `).run(qty, timestamp, itemId, sessionId, tenantId)
    this.touchSession(sessionId, tenantId, timestamp)
    return this.findItemById(itemId, tenantId)
  }

  removeItem(sessionId: string, itemId: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    this.requireActiveSession(sessionId, tenantId)
    const timestamp = nowIso()
    this.db.transaction(() => {
      this.db.prepare(`
        DELETE FROM inventory_count_entries
        WHERE inventory_item_id = ? AND session_id = ? AND tenant_id = ?
      `).run(itemId, sessionId, tenantId)
      this.db.prepare(`
        UPDATE inventory_items
        SET counted_stock = 0, was_counted = 0, price_checked = 0,
            observed_retail_price = NULL, last_counted_by = NULL,
            updated_at = ?, deleted_at = NULL
        WHERE id = ? AND session_id = ? AND tenant_id = ?
      `).run(timestamp, itemId, sessionId, tenantId)
      this.touchSession(sessionId, tenantId, timestamp)
    })
    return { ok: true }
  }

  applyPrice(sessionId: string, input: { tenant_id?: string; product_id: string; retail_price: number }): { data: any; session: any } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    this.requireSession(sessionId, tenantId)
    const timestamp = nowIso()
    this.db.transaction(() => {
      this.db.prepare('UPDATE products SET retail_price = ?, dirty_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
        .run(num(input.retail_price), timestamp, timestamp, input.product_id, tenantId)
      this.db.prepare('UPDATE inventory_items SET price_checked = 1, observed_retail_price = NULL, updated_at = ? WHERE session_id = ? AND product_id = ? AND tenant_id = ?')
        .run(timestamp, sessionId, input.product_id, tenantId)
      const product = this.productOutboxPayload(input.product_id, tenantId)
      if (product) this.addOutbox(tenantId, 'product', input.product_id, 'product.upsert', product, timestamp)
    })
    return { data: { product: this.findProductById(input.product_id, tenantId) }, session: this.getSessionData(sessionId, tenantId) }
  }

  complete(sessionId: string, input: { tenant_id?: string; user_id?: string | null } = {}): { items_updated: number } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const session = this.requireActiveSession(sessionId, tenantId)
    const timestamp = nowIso()
    const items = this.listCountedItems(sessionId, tenantId, -1)
    let updated = 0
    this.db.transaction(() => {
      for (const item of items) {
        if (!item.product_id) continue
        this.db.prepare('UPDATE products SET qty_on_hand = ?, dirty_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
          .run(num(item.counted_stock), timestamp, timestamp, item.product_id, tenantId)
        updated += 1
      }
      this.db.prepare(`
        UPDATE inventory_sessions
        SET status = 'completed', completed_at = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(timestamp, timestamp, timestamp, sessionId, tenantId)
      this.addOutbox(tenantId, 'inventory_session', sessionId, 'inventory.completed', {
        id: sessionId,
        name: session.name,
        created_by: session.created_by ?? input.user_id ?? null,
        created_at: session.created_at,
        completed_at: timestamp,
        items: items.map((item) => ({ product_id: item.product_id, counted_stock: num(item.counted_stock) })),
      }, timestamp)
    })
    return { items_updated: updated }
  }

  private getSessionRow(sessionId: string, tenantId: string): any | null {
    const row = this.db.prepare(`
      SELECT id, tenant_id, session_name AS name, status, started_by AS created_by,
             created_at, completed_at
      FROM inventory_sessions
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(sessionId, tenantId) as any | undefined
    return row ?? null
  }

  private requireSession(sessionId: string, tenantId: string): any {
    const session = this.getSessionRow(sessionId, tenantId)
    if (!session) throw new Error('Ревізію не знайдено')
    return session
  }

  private requireActiveSession(sessionId: string, tenantId: string): any {
    const session = this.requireSession(sessionId, tenantId)
    if (session.status !== 'in_progress') throw new Error('Ревізія не активна')
    return session
  }

  private findProductById(productId: string, tenantId: string): any | null {
    const row = this.db.prepare(`
      SELECT p.id, p.tenant_id, p.sku, p.name, p.barcode, p.brand_id, b.name AS brand_name,
             p.category_id, c.name AS category_name, p.unit, p.qty_on_hand, p.retail_price,
             p.purchase_price, p.reorder_point, p.notes, p.is_active, p.is_service,
             p.storage_bin, p.is_favorite, p.photo_url, p.specs_json
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
      LEFT JOIN categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id
      WHERE p.id = ? AND p.tenant_id = ? AND p.deleted_at IS NULL AND p.is_active = 1
      LIMIT 1
    `).get(productId, tenantId) as any | undefined
    return row ?? null
  }

  private productOutboxPayload(productId: string, tenantId: string): any | null {
    const product = this.findProductById(productId, tenantId)
    if (!product) return null
    let specs: Record<string, string> = {}
    if (product.specs_json) {
      try {
        const parsed = JSON.parse(product.specs_json)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) specs = parsed
      } catch {
        specs = {}
      }
    }
    return {
      id: product.id,
      sku: product.sku,
      name: product.name,
      barcode: product.barcode ?? null,
      brand_id: product.brand_id ?? null,
      category_id: product.category_id ?? null,
      unit: product.unit ?? 'шт',
      purchase_price: num(product.purchase_price),
      retail_price: num(product.retail_price),
      qty_on_hand: num(product.qty_on_hand),
      reorder_point: num(product.reorder_point),
      notes: product.notes ?? null,
      is_active: product.is_active === 1 || product.is_active === true,
      is_service: product.is_service === 1 || product.is_service === true,
      storage_bin: product.storage_bin ?? null,
      is_favorite: product.is_favorite === 1 || product.is_favorite === true,
      photo_url: product.photo_url ?? null,
      specs,
    }
  }

  private findProductByCode(code: string, tenantId: string): any | null {
    const normalized = String(code ?? '').trim()
    if (!normalized) return null
    const direct = this.db.prepare(`
      SELECT p.id, p.tenant_id, p.sku, p.name, p.barcode, p.brand_id, b.name AS brand_name,
             p.category_id, c.name AS category_name, p.unit, p.qty_on_hand, p.retail_price,
             p.purchase_price, p.reorder_point, p.notes, p.is_active, p.is_service,
             p.storage_bin, p.is_favorite, p.photo_url, p.specs_json
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
      LEFT JOIN categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id
      WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND p.is_active = 1
        AND (p.barcode = ? OR p.sku = ?)
      LIMIT 1
    `).get(tenantId, normalized, normalized) as any | undefined
    if (direct) return direct
    const extra = this.db.prepare(`
      SELECT p.id, p.tenant_id, p.sku, p.name, p.barcode, p.brand_id, br.name AS brand_name,
             p.category_id, c.name AS category_name, p.unit, p.qty_on_hand, p.retail_price,
             p.purchase_price, p.reorder_point, p.notes, p.is_active, p.is_service,
             p.storage_bin, p.is_favorite, p.photo_url, p.specs_json
      FROM product_barcodes b
      JOIN products p ON p.id = b.product_id AND p.tenant_id = b.tenant_id
      LEFT JOIN brands br ON br.id = p.brand_id AND br.tenant_id = p.tenant_id
      LEFT JOIN categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id
      WHERE b.tenant_id = ? AND b.barcode = ? AND b.deleted_at IS NULL
        AND p.deleted_at IS NULL AND p.is_active = 1
      LIMIT 1
    `).get(tenantId, normalized) as any | undefined
    return extra ?? null
  }

  private findItemByProduct(sessionId: string, productId: string, tenantId: string): any | null {
    const row = this.db.prepare(`
      SELECT id, product_id, expected_stock, counted_stock, price_checked,
             observed_retail_price, updated_at, was_counted
      FROM inventory_items
      WHERE session_id = ? AND product_id = ? AND tenant_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(sessionId, productId, tenantId) as any | undefined
    return row ?? null
  }

  private findItemById(itemId: string, tenantId: string): any | null {
    const row = this.db.prepare(`
      SELECT id, product_id, expected_stock, counted_stock, price_checked,
             observed_retail_price, updated_at, was_counted
      FROM inventory_items
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(itemId, tenantId) as any | undefined
    return this.decorateItem(row, tenantId)
  }

  private decorateItem(item: any | null, tenantId: string): any | null {
    if (!item) return null
    return {
      ...item,
      price_checked: item.price_checked === 1 || item.price_checked === true,
      product: this.findProductById(item.product_id, tenantId),
    }
  }

  private listCountedItems(sessionId: string, tenantId: string, limit: number): any[] {
    const rows = this.db.prepare(`
      SELECT id, product_id, expected_stock, counted_stock, price_checked,
             observed_retail_price, updated_at, was_counted
      FROM inventory_items
      WHERE session_id = ? AND tenant_id = ? AND deleted_at IS NULL AND was_counted = 1
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(sessionId, tenantId, limit) as any[]
    return rows.map((row) => ({
      ...row,
      price_checked: row.price_checked === 1,
      product: this.findProductById(row.product_id, tenantId),
    }))
  }

  private listPriceIssues(sessionId: string, tenantId: string): any[] {
    return this.listCountedItems(sessionId, tenantId, 200)
      .filter((item) => item.observed_retail_price !== null && item.observed_retail_price !== item.product?.retail_price)
      .map((item) => ({
        id: item.id,
        product_id: item.product_id,
        observed_retail_price: item.observed_retail_price,
        product: item.product,
      }))
  }

  private listEntries(sessionId: string, tenantId: string, userId: string): any[] {
    const rows = this.db.prepare(`
      SELECT id, product_id, qty, price_checked, observed_retail_price, created_at
      FROM inventory_count_entries
      WHERE session_id = ? AND tenant_id = ? AND deleted_at IS NULL
        AND (? = '' OR counted_by = ?)
      ORDER BY created_at DESC
      LIMIT 20
    `).all(sessionId, tenantId, userId, userId) as any[]
    return rows.map((row) => ({
      ...row,
      price_checked: row.price_checked === 1,
      product: this.findProductById(row.product_id, tenantId),
    }))
  }

  private summary(sessionId: string, tenantId: string): any {
    const totalProducts = this.totalProducts(tenantId)
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS counted_products,
        SUM(CASE WHEN counted_stock = expected_stock THEN 1 ELSE 0 END) AS matching_products,
        SUM(CASE WHEN counted_stock <> expected_stock THEN 1 ELSE 0 END) AS discrepancy_products,
        SUM(CASE WHEN price_checked = 1 THEN 1 ELSE 0 END) AS price_checked_products,
        SUM(CASE WHEN observed_retail_price IS NOT NULL THEN 1 ELSE 0 END) AS price_mismatch_products,
        SUM(expected_stock) AS total_expected_units,
        SUM(counted_stock) AS total_counted_units
      FROM inventory_items
      WHERE session_id = ? AND tenant_id = ? AND deleted_at IS NULL AND was_counted = 1
    `).get(sessionId, tenantId) as any
    return {
      total_products: totalProducts,
      counted_products: num(row?.counted_products),
      matching_products: num(row?.matching_products),
      discrepancy_products: num(row?.discrepancy_products),
      price_checked_products: num(row?.price_checked_products),
      price_mismatch_products: num(row?.price_mismatch_products),
      participants: 1,
      total_expected_units: num(row?.total_expected_units),
      total_counted_units: num(row?.total_counted_units),
    }
  }

  private totalProducts(tenantId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM products
      WHERE tenant_id = ? AND deleted_at IS NULL AND is_active = 1 AND is_service = 0
    `).get(tenantId) as { count: number }
    return num(row.count)
  }

  private touchSession(sessionId: string, tenantId: string, timestamp: string): void {
    this.db.prepare('UPDATE inventory_sessions SET dirty_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(timestamp, timestamp, sessionId, tenantId)
  }

  private addOutbox(tenantId: string, aggregateType: string, aggregateId: string, operationType: string, payload: unknown, timestamp: string): void {
    this.db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(randomUUID(), tenantId, this.db.deviceId, aggregateType, aggregateId, operationType, JSON.stringify(payload), timestamp)
  }
}