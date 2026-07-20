import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID, type LocalProduct, type LocalProductUpsert } from '../db/localTypes'

function nowIso(): string {
  return new Date().toISOString()
}

export function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? '')
    .toLocaleLowerCase('uk-UA')
    .replace(/ё/g, 'е')
    .replace(/ґ/g, 'г')
    .replace(/ї/g, 'и')
    .replace(/і/g, 'и')
    .replace(/є/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim()
}

export type LocalProductSortField = 'sku' | 'name' | 'retail_price' | 'qty_on_hand' | 'brand'
export type LocalProductSortDir = 'asc' | 'desc'

export interface LocalProductListOptions {
  query?: string
  categoryId?: string
  brandId?: string
  lowStock?: boolean
  stockFilter?: 'negative' | 'no_price' | ''
  limit?: number
  offset?: number
  sortField?: LocalProductSortField
  sortDir?: LocalProductSortDir
}

export interface LocalProductListResult {
  data: LocalProduct[]
  total: number
}
function productSearchNeedles(raw: string): string[] {
  const values = new Set<string>()
  const normalized = normalizeSearchText(raw)
  if (normalized) values.add(normalized)

  const latinToCyrillic: Array<[RegExp, string]> = [
    [/\bbooster\b/gi, 'бустер'],
    [/\bboost\b/gi, 'бустер'],
    [/\bwires?\b/gi, 'провода'],
  ]
  const cyrillicToLatin: Array<[RegExp, string]> = [
    [/бустер/gi, 'booster'],
    [/провод/gi, 'wire'],
  ]

  for (const [pattern, replacement] of [...latinToCyrillic, ...cyrillicToLatin]) {
    const variant = normalizeSearchText(raw.replace(pattern, replacement))
    if (variant) values.add(variant)
  }

  return [...values]
}

function productSearchTokens(raw: string): string[] {
  const tokens = new Set<string>()
  for (const needle of productSearchNeedles(raw)) {
    for (const token of needle.split(/\s+/)) {
      if (token.length >= 2) tokens.add(token)
    }
  }
  return [...tokens]
}

function compactLookupCode(raw: string): string {
  return raw.replace(/[\s\-._/]+/g, '').trim()
}

function productSearchText(product: LocalProductUpsert): string {
  return normalizeSearchText([
    product.sku,
    product.name,
    product.barcode,
    product.storage_bin,
    ...(product.additional_barcodes ?? []),
  ].filter(Boolean).join(' '))
}

export class LocalCatalogRepository {
  constructor(private readonly db: LocalDatabase) {}

  saveProduct(input: LocalProductUpsert): LocalProduct {
    const product = this.upsertProduct(input)
    this.addProductOutbox('product.upsert', product.id, input)
    return product
  }

  deleteProduct(id: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const timestamp = nowIso()
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE products
        SET deleted_at = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(timestamp, timestamp, timestamp, id, tenantId)
      this.addProductOutbox('product.deleted', id, { id, tenant_id: tenantId } as LocalProductUpsert)
    })
    return { ok: true }
  }

  upsertProduct(input: LocalProductUpsert): LocalProduct {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const timestamp = nowIso()
    const searchText = productSearchText(input)

    this.db.transaction(() => {
      this.ensureReferencePlaceholders(input, tenantId, timestamp)

      this.db.prepare(`
        INSERT INTO products (
          id, tenant_id, sku, name, barcode, brand_id, category_id, unit,
          purchase_price, retail_price, qty_on_hand, reorder_point, notes,
          is_active, is_service, storage_bin, is_favorite, photo_url, specs_json,
          search_text, dirty_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          sku = excluded.sku,
          name = excluded.name,
          barcode = excluded.barcode,
          brand_id = excluded.brand_id,
          category_id = excluded.category_id,
          unit = excluded.unit,
          purchase_price = excluded.purchase_price,
          retail_price = excluded.retail_price,
          qty_on_hand = excluded.qty_on_hand,
          reorder_point = excluded.reorder_point,
          notes = excluded.notes,
          is_active = excluded.is_active,
          is_service = excluded.is_service,
          storage_bin = excluded.storage_bin,
          is_favorite = excluded.is_favorite,
          photo_url = excluded.photo_url,
          specs_json = excluded.specs_json,
          search_text = excluded.search_text,
          dirty_at = excluded.dirty_at,
          updated_at = excluded.updated_at,
          deleted_at = NULL
      `).run(
        input.id,
        tenantId,
        input.sku,
        input.name,
        input.barcode ?? null,
        input.brand_id?.trim() || null,
        input.category_id?.trim() || null,
        input.unit ?? 'шт',
        input.purchase_price ?? 0,
        input.retail_price ?? 0,
        input.qty_on_hand ?? 0,
        input.reorder_point ?? 0,
        input.notes ?? null,
        input.is_active === false ? 0 : 1,
        input.is_service === true ? 1 : 0,
        input.storage_bin ?? null,
        input.is_favorite === true ? 1 : 0,
        input.photo_url ?? null,
        JSON.stringify(input.specs ?? {}),
        searchText,
        timestamp,
        timestamp,
        timestamp,
      )

      const barcodes = new Set([
        input.barcode ?? null,
        ...(input.additional_barcodes ?? []),
      ].filter((barcode): barcode is string => Boolean(barcode?.trim())))

      for (const barcode of barcodes) {
        this.db.prepare(`
          INSERT INTO product_barcodes (
            id, tenant_id, product_id, barcode, is_primary, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, barcode) DO UPDATE SET
            product_id = excluded.product_id,
            is_primary = excluded.is_primary,
            updated_at = excluded.updated_at,
            deleted_at = NULL
        `).run(
          randomUUID(),
          tenantId,
          input.id,
          barcode,
          barcode === input.barcode ? 1 : 0,
          timestamp,
          timestamp,
        )
      }
    })

    const product = this.findById(input.id, tenantId)
    if (!product) throw new Error('LOCAL_PRODUCT_UPSERT_FAILED')
    return product
  }

  findById(id: string, tenantId = DEFAULT_TENANT_ID): LocalProduct | null {
    const row = this.db.prepare(`
      SELECT id, tenant_id, sku, name, barcode, brand_id, category_id, unit,
             purchase_price, retail_price, qty_on_hand, reorder_point, notes, is_active,
             is_service, storage_bin, is_favorite, photo_url, specs_json
      FROM products
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).get(id, tenantId) as LocalProduct | undefined
    return row ?? null
  }

  findByBarcode(barcode: string, tenantId = DEFAULT_TENANT_ID): LocalProduct | null {
    const normalized = barcode.trim()
    if (!normalized) return null
    const compact = compactLookupCode(normalized)

    const row = this.db.prepare(`
      SELECT p.id, p.tenant_id, p.sku, p.name, p.barcode, p.unit, p.purchase_price,
             p.retail_price, p.qty_on_hand, p.is_active, p.is_service, p.storage_bin
      FROM products p
      WHERE p.tenant_id = ?
        AND p.deleted_at IS NULL
        AND p.is_active = 1
        AND (p.barcode = ? OR p.barcode = ?)
      UNION
      SELECT p.id, p.tenant_id, p.sku, p.name, p.barcode, p.unit, p.purchase_price,
             p.retail_price, p.qty_on_hand, p.is_active, p.is_service, p.storage_bin
      FROM product_barcodes b
      JOIN products p ON p.id = b.product_id
      WHERE b.tenant_id = ?
        AND b.deleted_at IS NULL
        AND (b.barcode = ? OR b.barcode = ?)
        AND p.deleted_at IS NULL
        AND p.is_active = 1
      LIMIT 1
    `).get(tenantId, normalized, compact, tenantId, normalized, compact) as LocalProduct | undefined

    return row ?? null
  }
  listProducts(options: LocalProductListOptions = {}, tenantId = DEFAULT_TENANT_ID): LocalProductListResult {
    const raw = (options.query ?? '').trim()
    const needles = productSearchNeedles(raw)
    const tokens = productSearchTokens(raw)
    const compact = compactLookupCode(raw)
    const limit = Math.max(1, Math.min(Number(options.limit ?? 100), 500))
    const offset = Math.max(0, Number(options.offset ?? 0) || 0)
    const sortColumns: Record<LocalProductSortField, string> = {
      sku: 'p.sku COLLATE NOCASE',
      name: 'p.name COLLATE NOCASE',
      retail_price: 'p.retail_price',
      qty_on_hand: 'p.qty_on_hand',
      brand: 'br.name COLLATE NOCASE',
    }
    const sortField = options.sortField && sortColumns[options.sortField]
      ? options.sortField
      : null
    const sortDir = options.sortDir === 'desc' ? 'DESC' : 'ASC'

    const where = ['p.tenant_id = ?', 'p.deleted_at IS NULL', 'p.is_active = 1']
    const params: Array<string | number> = [tenantId]
    if (options.categoryId) {
      where.push('p.category_id = ?')
      params.push(options.categoryId)
    }
    if (options.brandId) {
      where.push('p.brand_id = ?')
      params.push(options.brandId)
    }
    if (options.lowStock) {
      where.push('p.qty_on_hand <= p.reorder_point')
    }
    if (options.stockFilter === 'negative') {
      where.push('p.qty_on_hand < 0')
    }
    if (options.stockFilter === 'no_price') {
      where.push('p.retail_price = 0')
    }
    if (raw) {
      const searchClauses = [
        'p.sku = ?',
        'p.sku = ?',
        'p.barcode = ?',
        'p.barcode = ?',
        'p.barcode LIKE ?',
        'p.name LIKE ?',
        `EXISTS (
          SELECT 1 FROM product_barcodes b
          WHERE b.tenant_id = p.tenant_id
            AND b.product_id = p.id
            AND b.deleted_at IS NULL
            AND (b.barcode = ? OR b.barcode = ? OR b.barcode LIKE ?)
        )`,
      ]
      const searchParams: Array<string | number> = [
        raw,
        compact,
        raw,
        compact,
        `%${raw}%`,
        `%${raw}%`,
        raw,
        compact,
        `%${raw}%`,
      ]
      for (const needle of needles) {
        searchClauses.push('p.search_text LIKE ?')
        searchParams.push(`%${needle}%`)
      }
      if (tokens.length > 1) {
        searchClauses.push(`(${tokens.map(() => 'p.search_text LIKE ?').join(' AND ')})`)
        searchParams.push(...tokens.map((token) => `%${token}%`))
      }
      where.push(`(${searchClauses.join(' OR ')})`)
      params.push(...searchParams)
    }

    const whereSql = where.join(' AND ')
    const orderParts: string[] = []
    const dataParams = [...params]
    if (raw) {
      orderParts.push('CASE WHEN p.sku = ? OR p.barcode = ? THEN 0 ELSE 1 END')
      dataParams.push(raw, raw)
    }
    if (sortField) {
      orderParts.push(`${sortColumns[sortField]} ${sortDir}`)
    } else {
      orderParts.push('p.is_favorite DESC', 'p.name COLLATE NOCASE ASC')
    }
    if (sortField !== 'name') orderParts.push('p.name COLLATE NOCASE ASC')
    orderParts.push('p.id ASC')

    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM products p
      WHERE ${whereSql}
    `).get(...params) as { total?: number } | undefined

    const data = this.db.prepare(`
      SELECT p.id, p.tenant_id, p.sku, p.name, p.barcode,
             p.brand_id, br.name AS brand_name, p.category_id, c.name AS category_name,
             p.unit, p.purchase_price, p.retail_price, p.qty_on_hand, p.reorder_point,
             p.notes, p.is_active, p.is_service, p.storage_bin, p.is_favorite, p.photo_url, p.specs_json
      FROM products p
      LEFT JOIN brands br ON br.id = p.brand_id AND br.tenant_id = p.tenant_id AND br.deleted_at IS NULL
      LEFT JOIN categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id AND c.deleted_at IS NULL
      WHERE ${whereSql}
      ORDER BY ${orderParts.join(', ')}
      LIMIT ? OFFSET ?
    `).all(...dataParams, limit, offset) as unknown as LocalProduct[]

    return { data, total: Number(totalRow?.total ?? data.length) }
  }
  // Перші N активних товарів (обране — вперед). Для показу «популярних» у касі
  // до вводу назви, коли поле пошуку порожнє.
  listPopular(tenantId = DEFAULT_TENANT_ID, limit = 50): LocalProduct[] {
    return this.db.prepare(`
      SELECT id, tenant_id, sku, name, barcode, unit, purchase_price, retail_price,
             qty_on_hand, reorder_point, notes, is_active, is_service, storage_bin, is_favorite, photo_url, specs_json
      FROM products
      WHERE tenant_id = ? AND deleted_at IS NULL AND is_active = 1
      ORDER BY is_favorite DESC, name ASC
      LIMIT ?
    `).all(tenantId, limit) as unknown as LocalProduct[]
  }

  searchProducts(query: string, tenantId = DEFAULT_TENANT_ID, limit = 20): LocalProduct[] {
    const raw = query.trim()
    if (!raw) return []

    const exact = this.findByBarcode(raw, tenantId)
    if (exact) return [exact]

    const needles = productSearchNeedles(raw)
    const tokens = productSearchTokens(raw)
    const compact = compactLookupCode(raw)
    const clauses = [
      'sku = ?',
      'sku = ?',
      'barcode = ?',
      'barcode = ?',
      'barcode LIKE ?',
      'name LIKE ?',
    ]
    const params: Array<string | number> = [tenantId, raw, compact, raw, compact, `%${raw}%`, `%${raw}%`]
    for (const needle of needles) {
      clauses.push('search_text LIKE ?')
      params.push(`%${needle}%`)
    }
    if (tokens.length > 1) {
      clauses.push(`(${tokens.map(() => 'search_text LIKE ?').join(' AND ')})`)
      params.push(...tokens.map((token) => `%${token}%`))
    }

    return this.db.prepare(`
      SELECT id, tenant_id, sku, name, barcode, unit, purchase_price, retail_price,
             qty_on_hand, reorder_point, notes, is_active, is_service, storage_bin, is_favorite, photo_url, specs_json
      FROM products
      WHERE tenant_id = ?
        AND deleted_at IS NULL
        AND is_active = 1
        AND (${clauses.join(' OR ')})
      ORDER BY
        CASE WHEN sku = ? OR sku = ? OR barcode = ? OR barcode = ? THEN 0 ELSE 1 END,
        is_favorite DESC,
        name ASC
      LIMIT ?
    `).all(...params, raw, compact, raw, compact, limit) as unknown as LocalProduct[]
  }
  private ensureReferencePlaceholders(input: LocalProductUpsert, tenantId: string, timestamp: string): void {
    const brandId = input.brand_id?.trim()
    if (brandId && !this.referenceExists('brands', brandId, tenantId)) {
      this.db.prepare(`
        INSERT INTO brands (id, tenant_id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(brandId, tenantId, `Бренд ${brandId.slice(0, 8)}`, timestamp, timestamp)
    }

    const categoryId = input.category_id?.trim()
    if (categoryId && !this.referenceExists('categories', categoryId, tenantId)) {
      this.db.prepare(`
        INSERT INTO categories (id, tenant_id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(categoryId, tenantId, `Папка ${categoryId.slice(0, 8)}`, timestamp, timestamp)
    }
  }

  private referenceExists(table: 'brands' | 'categories', id: string, tenantId: string): boolean {
    const row = this.db.prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1`).get(id, tenantId)
    return Boolean(row)
  }

  private addProductOutbox(operationType: 'product.upsert' | 'product.deleted', productId: string, payload: LocalProductUpsert): void {
    const timestamp = nowIso()
    const tenantId = payload.tenant_id ?? DEFAULT_TENANT_ID
    this.db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, created_at
      )
      VALUES (?, ?, ?, 'product', ?, ?, ?, 'pending', ?)
    `).run(
      randomUUID(),
      tenantId,
      this.db.deviceId,
      productId,
      operationType,
      JSON.stringify(payload),
      timestamp,
    )
  }
}
