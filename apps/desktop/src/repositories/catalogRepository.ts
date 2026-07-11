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

  upsertProduct(input: LocalProductUpsert): LocalProduct {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const timestamp = nowIso()
    const searchText = productSearchText(input)

    this.db.transaction(() => {
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
        input.brand_id ?? null,
        input.category_id ?? null,
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
      SELECT id, tenant_id, sku, name, barcode, unit, purchase_price, retail_price,
             qty_on_hand, is_active, is_service, storage_bin
      FROM products
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).get(id, tenantId) as LocalProduct | undefined
    return row ?? null
  }

  findByBarcode(barcode: string, tenantId = DEFAULT_TENANT_ID): LocalProduct | null {
    const normalized = barcode.trim()
    if (!normalized) return null

    const row = this.db.prepare(`
      SELECT p.id, p.tenant_id, p.sku, p.name, p.barcode, p.unit, p.purchase_price,
             p.retail_price, p.qty_on_hand, p.is_active, p.is_service, p.storage_bin
      FROM products p
      WHERE p.tenant_id = ?
        AND p.deleted_at IS NULL
        AND p.is_active = 1
        AND p.barcode = ?
      UNION
      SELECT p.id, p.tenant_id, p.sku, p.name, p.barcode, p.unit, p.purchase_price,
             p.retail_price, p.qty_on_hand, p.is_active, p.is_service, p.storage_bin
      FROM product_barcodes b
      JOIN products p ON p.id = b.product_id
      WHERE b.tenant_id = ?
        AND b.deleted_at IS NULL
        AND b.barcode = ?
        AND p.deleted_at IS NULL
        AND p.is_active = 1
      LIMIT 1
    `).get(tenantId, normalized, tenantId, normalized) as LocalProduct | undefined

    return row ?? null
  }

  searchProducts(query: string, tenantId = DEFAULT_TENANT_ID, limit = 20): LocalProduct[] {
    const raw = query.trim()
    if (!raw) return []

    const exact = this.findByBarcode(raw, tenantId)
    if (exact) return [exact]

    const needle = `%${normalizeSearchText(raw)}%`
    return this.db.prepare(`
      SELECT id, tenant_id, sku, name, barcode, unit, purchase_price, retail_price,
             qty_on_hand, is_active, is_service, storage_bin
      FROM products
      WHERE tenant_id = ?
        AND deleted_at IS NULL
        AND is_active = 1
        AND (
          sku = ?
          OR search_text LIKE ?
          OR name LIKE ?
        )
      ORDER BY
        CASE WHEN sku = ? THEN 0 ELSE 1 END,
        is_favorite DESC,
        name ASC
      LIMIT ?
    `).all(tenantId, raw, needle, `%${raw}%`, raw, limit) as unknown as LocalProduct[]
  }
}
