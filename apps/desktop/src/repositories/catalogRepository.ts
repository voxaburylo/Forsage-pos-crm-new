import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID, type LocalProduct, type LocalProductUpsert } from '../db/localTypes'

function nowIso(): string {
  return new Date().toISOString()
}

const PRODUCT_SEARCH_REPAIR_KEY = 'product_search_index_repair_version'
const PRODUCT_SEARCH_REPAIR_VERSION = 2
const MAX_MONEY_VALUE = 2_147_483_647

function validMoney(value: number | undefined, field: string): number {
  const normalized = Number(value ?? 0)
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > MAX_MONEY_VALUE) {
    throw new Error(`${field} має містити коректну суму`)
  }
  return Math.round(normalized)
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

export interface LocalProductSaveOptions {
  reuseExistingSku?: boolean
}

export interface LocalCatalogCategory {
  id: string
  name: string
  sort_order: number
}

export interface LocalCatalogBrand {
  id: string
  name: string
  country: string | null
}

export function normalizeCatalogCode(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleUpperCase('uk-UA')
    .replace(/[^A-ZА-ЯІЇЄҐ0-9]/g, '')
}

export function catalogCodesFromName(value: string | null | undefined): string[] {
  const pieces = String(value ?? '')
    .normalize('NFKC')
    .toLocaleUpperCase('uk-UA')
    .split(/\s+/)
    .map((piece) => piece.replace(/^[^A-ZА-ЯІЇЄҐ0-9]+|[^A-ZА-ЯІЇЄҐ0-9]+$/g, ''))
    .filter(Boolean)
  const codes = new Set<string>()
  for (const piece of pieces) {
    const code = normalizeCatalogCode(piece)
    if (code.length >= 4 && /[A-ZА-ЯІЇЄҐ]/.test(code) && /\d/.test(code)) {
      codes.add(code)
    }
  }
  for (let index = 0; index + 1 < pieces.length; index += 1) {
    const left = pieces[index]
    const right = pieces[index + 1]
    if (/^[A-Z]{1,3}$/.test(left) && /^\d[\d./_-]*$/.test(right)) {
      const code = normalizeCatalogCode(left + right)
      if (code.length >= 4) codes.add(code)
    }
  }
  return [...codes]
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

function normalizedSkuLookup(raw: string): string {
  return raw.normalize('NFKC').trim().toLocaleUpperCase('uk-UA')
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
  constructor(private readonly db: LocalDatabase) {
    this.repairProductSearchIndex()
  }

  private repairProductSearchIndex(): void {
    const marker = this.db.prepare('SELECT value_json FROM app_meta WHERE key = ?')
      .get(PRODUCT_SEARCH_REPAIR_KEY) as { value_json: string } | undefined
    try {
      if (marker && Number(JSON.parse(marker.value_json)) === PRODUCT_SEARCH_REPAIR_VERSION) return
    } catch {
      // Invalid marker is treated as an unfinished repair.
    }

    try {
      const rows = this.db.prepare(`
        SELECT p.id, p.tenant_id, p.sku, p.name, p.barcode, p.storage_bin, p.search_text,
               GROUP_CONCAT(b.barcode, ' ') AS extra_barcodes
        FROM products p
        LEFT JOIN product_barcodes b
          ON b.tenant_id = p.tenant_id
         AND b.product_id = p.id
         AND b.deleted_at IS NULL
        WHERE p.deleted_at IS NULL
        GROUP BY p.id, p.tenant_id
      `).all() as Array<{
        id: string
        tenant_id: string
        sku: string
        name: string
        barcode?: string | null
        storage_bin?: string | null
        search_text?: string | null
        extra_barcodes?: string | null
      }>

      const update = this.db.prepare('UPDATE products SET search_text = ? WHERE id = ? AND tenant_id = ?')
      const repairedAt = nowIso()
      this.db.transaction(() => {
        for (const row of rows) {
          const next = normalizeSearchText([
            row.sku,
            row.name,
            row.barcode,
            row.storage_bin,
            row.extra_barcodes,
          ].filter(Boolean).join(' '))
          if (next && next !== (row.search_text ?? '')) update.run(next, row.id, row.tenant_id)
        }
        this.db.prepare(`
          INSERT INTO app_meta(key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `).run(PRODUCT_SEARCH_REPAIR_KEY, JSON.stringify(PRODUCT_SEARCH_REPAIR_VERSION), repairedAt)
      })
    } catch {
      // Пошук не повинен блокувати запуск програми. Маркер не ставимо:
      // безпечний одноразовий ремонт повториться при наступному старті.
    }
  }
  saveProduct(input: LocalProductUpsert, options: LocalProductSaveOptions = {}): LocalProduct {
    // Картка та запис на відправлення — одна транзакція, навіть при помилці
    // outbox. Застарілий відкритий редактор не читає залишок до блокування.
    return this.db.transaction(() => this.saveProductInTransaction(input, options))
  }

  private saveProductInTransaction(input: LocalProductUpsert, options: LocalProductSaveOptions): LocalProduct {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const storedById = this.findStoredProductById(input.id, tenantId)

    // Для накладної повторний код постачальника повинен прив'язатися до вже
    // відомої активної картки. Звичайне створення товару й надалі показує
    // зрозумілу помилку про дублікат активного артикула.
    if (!storedById) {
      const storedBySku = this.findStoredProductBySku(input.sku, tenantId, true)
      if (storedBySku) {
        if (storedBySku.deleted_at) {
          if (options.reuseExistingSku) {
            const activeReplacement = this.findActiveReplacement(input, storedBySku, tenantId)
            if (activeReplacement) return activeReplacement
          }
          return this.restoreStoredProduct(storedBySku, input, tenantId)
        }
        const existing = this.findById(storedBySku.id, tenantId)
        if (existing && options.reuseExistingSku) return existing
        throw new Error(`Товар з артикулом "${input.sku}" вже існує`)
      }
    }

    // Product details must not overwrite stock changed by sales, supply or inventory.
    const safeInput = storedById && input.stock_correction !== true
      ? { ...input, qty_on_hand: Number(storedById.qty_on_hand ?? 0) }
      : input
    const product = this.upsertProduct(safeInput)
    this.addProductOutbox('product.upsert', product.id, {
      ...safeInput,
      brand_id: product.brand_id ?? null,
      category_id: product.category_id ?? null,
    })
    return product
  }

  deleteProduct(id: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const timestamp = nowIso()
    this.db.transaction(() => {
      // Якщо на товарі є залишок — не ховаємо його «тихо» (раніше видалені товари
      // лишались із qty>0 і склад застрягав). Списуємо в нуль зі слідом у русі складу.
      const prev = this.db.prepare('SELECT qty_on_hand FROM products WHERE id = ? AND tenant_id = ?')
        .get(id, tenantId) as { qty_on_hand?: number } | undefined
      const prevQty = Number(prev?.qty_on_hand ?? 0)
      if (prevQty !== 0) {
        this.db.prepare(`
          INSERT INTO inventory_movements (
            id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
            unit_cost, notes, dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'adjustment', ?, ?, 0, 0, ?, ?, ?, ?)
        `).run(randomUUID(), tenantId, id, id, -prevQty, 'Списання залишку при видаленні товару', timestamp, timestamp, timestamp)
      }
      this.db.prepare(`
        UPDATE products
        SET deleted_at = ?, qty_on_hand = 0, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(timestamp, timestamp, timestamp, id, tenantId)
      this.addProductOutbox('product.deleted', id, { id, tenant_id: tenantId } as LocalProductUpsert)
    })
    return { ok: true }
  }

  upsertProduct(input: LocalProductUpsert): LocalProduct {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    input = this.normalizeProductReferences(input, tenantId)
    input = {
      ...input,
      purchase_price: validMoney(input.purchase_price, 'Ціна закупівлі'),
      retail_price: validMoney(input.retail_price, 'Ціна продажу'),
      core_deposit_amount: validMoney(input.core_deposit_amount, 'Застава'),
    }
    const timestamp = nowIso()
    const searchText = productSearchText(input)
    const stockBefore = this.findStoredProductById(input.id, tenantId)

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO products (
          id, tenant_id, sku, name, barcode, brand_id, category_id, unit,
          purchase_price, retail_price, qty_on_hand, reorder_point, notes,
          is_active, is_service, requires_core_return, core_deposit_amount,
          storage_bin, is_favorite, photo_url, specs_json,
          search_text, dirty_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          requires_core_return = excluded.requires_core_return,
          core_deposit_amount = excluded.core_deposit_amount,
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
        input.requires_core_return === true ? 1 : 0,
        Math.max(0, Math.round(Number(input.core_deposit_amount ?? 0))),
        input.storage_bin ?? null,
        input.is_favorite === true ? 1 : 0,
        input.photo_url ?? null,
        JSON.stringify(input.specs ?? {}),
        searchText,
        timestamp,
        timestamp,
        timestamp,
      )

      const barcodeEntries = new Map<string, { isPrimary: boolean }>()
      const collectBarcode = (value: string | null | undefined, isPrimary: boolean) => {
        const barcode = String(value ?? '').trim()
        if (!barcode) return
        const previous = barcodeEntries.get(barcode)
        barcodeEntries.set(barcode, { isPrimary: isPrimary || previous?.isPrimary === true })
      }
      collectBarcode(input.barcode, true)
      const replacesAdditionalBarcodes = input.additional_barcodes !== undefined
      for (const barcode of input.additional_barcodes ?? []) collectBarcode(barcode, false)
      const barcodeValues = [...barcodeEntries.keys()]

      for (const barcode of barcodeValues) {
        const duplicateFromIndex = this.db.prepare(`
          SELECT p.name, p.sku
          FROM product_barcodes b
          JOIN products p ON p.id = b.product_id AND p.tenant_id = b.tenant_id
          WHERE b.tenant_id = ?
            AND b.barcode = ?
            AND b.deleted_at IS NULL
            AND b.product_id <> ?
            AND p.deleted_at IS NULL
          LIMIT 1
        `).get(tenantId, barcode, input.id) as { name?: string; sku?: string } | undefined
        const duplicateFromProduct = duplicateFromIndex ?? this.db.prepare(`
          SELECT name, sku
          FROM products
          WHERE tenant_id = ?
            AND barcode = ?
            AND deleted_at IS NULL
            AND id <> ?
          LIMIT 1
        `).get(tenantId, barcode, input.id) as { name?: string; sku?: string } | undefined
        if (duplicateFromProduct) {
          const label = duplicateFromProduct.name || duplicateFromProduct.sku || 'іншого товару'
          throw new Error(`Штрихкод "${barcode}" вже у товару "${label}"`)
        }
      }

      const stockAfter = Number(input.qty_on_hand ?? 0)
      const stockBeforeValue = stockBefore ? Number(stockBefore.qty_on_hand ?? 0) : 0
      if (stockAfter !== stockBeforeValue) {
        this.db.prepare(`
          INSERT INTO inventory_movements (
            id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
            unit_cost, notes, dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), tenantId, input.id,
          stockBefore ? 'product_correction' : 'opening_balance',
          input.id, stockAfter - stockBeforeValue, stockAfter,
          input.purchase_price ?? 0,
          stockBefore ? 'Ручне коригування залишку в картці товару' : 'Початковий залишок товару',
          timestamp, timestamp, timestamp,
        )
      }

      if (replacesAdditionalBarcodes) {
        if (barcodeValues.length > 0) {
          const placeholders = barcodeValues.map(() => '?').join(', ')
          this.db.prepare(`
            UPDATE product_barcodes
            SET deleted_at = ?, updated_at = ?, is_primary = 0
            WHERE tenant_id = ?
              AND product_id = ?
              AND deleted_at IS NULL
              AND barcode NOT IN (${placeholders})
          `).run(timestamp, timestamp, tenantId, input.id, ...barcodeValues)
        } else {
          this.db.prepare(`
            UPDATE product_barcodes
            SET deleted_at = ?, updated_at = ?, is_primary = 0
            WHERE tenant_id = ?
              AND product_id = ?
              AND deleted_at IS NULL
          `).run(timestamp, timestamp, tenantId, input.id)
        }
      } else {
        // Часткове редагування картки не повинно стирати додаткові штрихкоди,
        // отримані з імпорту або сервера. Оновлюємо лише попередній основний код.
        const primaryBarcode = String(input.barcode ?? '').trim()
        this.db.prepare(`
          UPDATE product_barcodes
          SET deleted_at = ?, updated_at = ?, is_primary = 0
          WHERE tenant_id = ?
            AND product_id = ?
            AND deleted_at IS NULL
            AND is_primary = 1
            AND (? = '' OR barcode <> ?)
        `).run(timestamp, timestamp, tenantId, input.id, primaryBarcode, primaryBarcode)
      }

      for (const [barcode, meta] of barcodeEntries) {
        this.db.prepare(`
          INSERT INTO product_barcodes (
            id, tenant_id, product_id, barcode, is_primary, created_at, updated_at, deleted_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(tenant_id, barcode) DO UPDATE SET
            product_id = excluded.product_id,
            is_primary = excluded.is_primary,
            updated_at = excluded.updated_at,
            deleted_at = NULL
          WHERE product_barcodes.product_id = excluded.product_id
        `).run(
          randomUUID(),
          tenantId,
          input.id,
          barcode,
          meta.isPrimary ? 1 : 0,
          timestamp,
          timestamp,
        )
      }

      // Крос-номери/аналоги: повний список із картки товару замінює наявні.
      // undefined = не чіпати (часткове редагування); [] = очистити.
      if (input.cross_numbers !== undefined) {
        this.db.prepare('DELETE FROM product_cross_numbers WHERE tenant_id = ? AND product_id = ?')
          .run(tenantId, input.id)
        const insertCross = this.db.prepare(`
          INSERT INTO product_cross_numbers (
            id, tenant_id, product_id, cross_number, brand, source, notes, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, NULL, 'Картка товару', NULL, ?, ?)
          ON CONFLICT(tenant_id, product_id, cross_number) DO NOTHING
        `)
        const seenCross = new Set<string>()
        for (const raw of input.cross_numbers) {
          const num = String(raw ?? '').trim()
          const key = num.toUpperCase()
          if (!num || seenCross.has(key)) continue
          seenCross.add(key)
          insertCross.run(randomUUID(), tenantId, input.id, num, timestamp, timestamp)
        }
      }
    })

    const product = this.findById(input.id, tenantId)
    if (!product) throw new Error('LOCAL_PRODUCT_UPSERT_FAILED')
    return product
  }

  listCrossNumbers(productId: string, tenantId = DEFAULT_TENANT_ID): Array<{ id: string; number: string; source: string }> {
    const rows = this.db.prepare(`
      SELECT id, cross_number AS number, source
      FROM product_cross_numbers
      WHERE tenant_id = ? AND product_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC
    `).all(tenantId, productId) as Array<{ id: string; number: string; source: string }>
    return rows
  }

  listAnalogs(productId: string, tenantId = DEFAULT_TENANT_ID, limit = 50): LocalProduct[] {
    const source = this.findById(productId, tenantId)
    if (!source) return []

    const sourceCrosses = this.listCrossNumbers(productId, tenantId)
    const lookupCodes = new Set<string>([
      ...catalogCodesFromName(source.name),
      ...sourceCrosses.map((row) => normalizeCatalogCode(row.number)),
      ...sourceCrosses.flatMap((row) => catalogCodesFromName(row.number)),
    ].filter((code) => code.length >= 4))
    if (lookupCodes.size === 0) return []

    const products = this.db.prepare(`
      SELECT p.id, p.tenant_id, p.sku, p.name, p.barcode,
             p.brand_id, br.name AS brand_name, p.category_id, c.name AS category_name,
             p.unit, p.purchase_price, p.retail_price, p.qty_on_hand, p.reorder_point,
             p.notes, p.is_active, p.is_service, p.requires_core_return, p.core_deposit_amount,
             p.storage_bin, p.is_favorite, p.photo_url, p.specs_json, p.created_at, p.updated_at
      FROM products p
      LEFT JOIN brands br ON br.id = p.brand_id AND br.tenant_id = p.tenant_id AND br.deleted_at IS NULL
      LEFT JOIN categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id AND c.deleted_at IS NULL
      WHERE p.tenant_id = ?
        AND p.id <> ?
        AND p.deleted_at IS NULL
        AND p.is_active = 1
    `).all(tenantId, productId) as unknown as LocalProduct[]

    const crossRows = this.db.prepare(`
      SELECT product_id, cross_number
      FROM product_cross_numbers
      WHERE tenant_id = ? AND product_id <> ? AND deleted_at IS NULL
    `).all(tenantId, productId) as Array<{ product_id: string; cross_number: string }>
    const crossesByProduct = new Map<string, string[]>()
    for (const row of crossRows) {
      const values = crossesByProduct.get(row.product_id) ?? []
      values.push(row.cross_number)
      crossesByProduct.set(row.product_id, values)
    }

    const matched = products.filter((product) => {
      const candidateCodes = new Set<string>([
        ...catalogCodesFromName(product.name),
        normalizeCatalogCode(product.sku),
        normalizeCatalogCode(product.barcode),
        ...(crossesByProduct.get(product.id) ?? []).map(normalizeCatalogCode),
      ].filter((code) => code.length >= 4))
      for (const code of lookupCodes) {
        if (candidateCodes.has(code)) return true
      }
      return false
    })

    return this.attachAvailability(matched, tenantId)
      .sort((left, right) =>
        Number(Number(right.qty_available ?? right.qty_on_hand) > 0 || right.is_service === 1)
        - Number(Number(left.qty_available ?? left.qty_on_hand) > 0 || left.is_service === 1)
        || String(left.name).localeCompare(String(right.name), 'uk', { sensitivity: 'base' }),
      )
      .slice(0, Math.max(1, Math.min(Number(limit) || 50, 100)))
  }

  findById(id: string, tenantId = DEFAULT_TENANT_ID): LocalProduct | null {
    const row = this.db.prepare(`
      SELECT id, tenant_id, sku, name, barcode, brand_id, category_id, unit,
             purchase_price, retail_price, qty_on_hand, reorder_point, notes, is_active,
             is_service, requires_core_return, core_deposit_amount, storage_bin,
             is_favorite, photo_url, specs_json, created_at, updated_at
      FROM products
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).get(id, tenantId) as LocalProduct | undefined
    return row ? (this.attachAvailability([row], tenantId)[0] ?? null) : null
  }

  findBySku(sku: string, tenantId = DEFAULT_TENANT_ID): LocalProduct | null {
    const active = this.findStoredProductBySku(sku, tenantId, false)
    if (active) return this.attachAvailability([active as LocalProduct], tenantId)[0] ?? null

    // Старі імпорти використовували код постачальника як SKU, а після
    // очищення дублів така картка лишилась tombstone. Використовуємо її як
    // місток до єдиної активної картки з тим самим штрихкодом або назвою.
    const deleted = this.findStoredProductBySku(sku, tenantId, true)
    if (!deleted?.deleted_at) return null
    return this.findActiveReplacement({
      id: deleted.id,
      sku: deleted.sku,
      name: deleted.name,
      barcode: deleted.barcode,
    }, deleted, tenantId)
  }

  private findStoredProductById(id: string, tenantId: string): (LocalProduct & { deleted_at: string | null }) | null {
    const row = this.db.prepare(`
      SELECT id, tenant_id, sku, name, barcode, brand_id, category_id, unit,
             purchase_price, retail_price, qty_on_hand, reorder_point, notes, is_active,
             is_service, requires_core_return, core_deposit_amount, storage_bin,
             is_favorite, photo_url, specs_json, created_at, updated_at, deleted_at
      FROM products
      WHERE id = ? AND tenant_id = ?
      LIMIT 1
    `).get(id, tenantId) as (LocalProduct & { deleted_at: string | null }) | undefined
    return row ?? null
  }

  private findStoredProductBySku(
    sku: string,
    tenantId: string,
    includeDeleted: boolean,
  ): (LocalProduct & { deleted_at: string | null }) | null {
    const raw = sku.normalize('NFKC').trim()
    if (!raw) return null

    const deletedClause = includeDeleted ? '' : 'AND deleted_at IS NULL'
    const exact = this.db.prepare(`
      SELECT id, tenant_id, sku, name, barcode, brand_id, category_id, unit,
             purchase_price, retail_price, qty_on_hand, reorder_point, notes, is_active,
             is_service, requires_core_return, core_deposit_amount, storage_bin,
             is_favorite, photo_url, specs_json, created_at, updated_at, deleted_at
      FROM products
      WHERE tenant_id = ?
        ${deletedClause}
        AND trim(sku) = ? COLLATE NOCASE
      ORDER BY CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1
    `).get(tenantId, raw) as (LocalProduct & { deleted_at: string | null }) | undefined
    if (exact) return exact

    const lookup = normalizedSkuLookup(raw)
    if (!lookup) return null
    const candidates = this.db.prepare(`
      SELECT id, sku, deleted_at
      FROM products
      WHERE tenant_id = ?
        ${deletedClause}
      ORDER BY CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END, updated_at DESC
    `).all(tenantId) as unknown as Array<{ id: string; sku: string; deleted_at: string | null }>
    const candidate = candidates.find((row) => normalizedSkuLookup(row.sku) === lookup)
    return candidate ? this.findStoredProductById(candidate.id, tenantId) : null
  }

  private restoreStoredProduct(
    stored: LocalProduct & { deleted_at: string | null },
    input: LocalProductUpsert,
    tenantId: string,
  ): LocalProduct {
    const restored = this.upsertProduct({
      ...input,
      id: stored.id,
      tenant_id: tenantId,
      is_active: true,
      qty_on_hand: Number(input.qty_on_hand ?? 0),
    })
    if (!restored) throw new Error('LOCAL_PRODUCT_RESTORE_FAILED')
    this.addProductOutbox('product.upsert', restored.id, {
      id: restored.id,
      tenant_id: tenantId,
      sku: restored.sku,
      name: restored.name,
      barcode: restored.barcode,
      brand_id: restored.brand_id,
      category_id: restored.category_id,
      unit: restored.unit,
      purchase_price: restored.purchase_price,
      retail_price: restored.retail_price,
      qty_on_hand: restored.qty_on_hand,
      reorder_point: (restored as any).reorder_point ?? 0,
      notes: (restored as any).notes ?? null,
      is_active: true,
      is_service: restored.is_service === 1,
      requires_core_return: restored.requires_core_return === 1,
      core_deposit_amount: Number(restored.core_deposit_amount ?? 0),
      storage_bin: restored.storage_bin,
      is_favorite: (restored as any).is_favorite === 1,
      photo_url: (restored as any).photo_url ?? null,
    })
    return restored
  }

  private findActiveReplacement(
    input: LocalProductUpsert,
    deletedProduct: LocalProduct & { deleted_at: string | null },
    tenantId: string,
  ): LocalProduct | null {
    for (const barcode of [input.barcode, deletedProduct.barcode]) {
      const normalized = String(barcode ?? '').trim()
      if (!normalized) continue
      const byBarcode = this.findByBarcode(normalized, tenantId)
      if (byBarcode && byBarcode.id !== deletedProduct.id) return byBarcode
    }

    const wantedNames = new Set(
      [input.name, deletedProduct.name]
        .map((name) => normalizeSearchText(name))
        .filter((name) => name.length >= 6),
    )
    if (wantedNames.size === 0) return null

    const candidates = this.db.prepare(`
      SELECT id, tenant_id, sku, name, barcode, brand_id, category_id, unit,
             purchase_price, retail_price, qty_on_hand, reorder_point, notes, is_active,
             is_service, requires_core_return, core_deposit_amount, storage_bin,
             is_favorite, photo_url, specs_json, created_at, updated_at
      FROM products
      WHERE tenant_id = ?
        AND deleted_at IS NULL
        AND is_active = 1
        AND id <> ?
    `).all(tenantId, deletedProduct.id) as unknown as LocalProduct[]
    const exactNameMatches = candidates.filter((candidate) => wantedNames.has(normalizeSearchText(candidate.name)))
    return exactNameMatches.length === 1 ? (this.attachAvailability([exactNameMatches[0]], tenantId)[0] ?? null) : null
  }

  listProductBarcodes(tenantId = DEFAULT_TENANT_ID): Array<{ product_id: string; barcode: string; is_primary: number }> {
    return this.db.prepare(`
      SELECT product_id, barcode, is_primary
      FROM product_barcodes
      WHERE tenant_id = ?
        AND deleted_at IS NULL
      ORDER BY is_primary DESC, updated_at DESC
    `).all(tenantId) as Array<{ product_id: string; barcode: string; is_primary: number }>
  }

  findByBarcode(barcode: string, tenantId = DEFAULT_TENANT_ID): LocalProduct | null {
    const normalized = barcode.trim()
    if (!normalized) return null
    const compact = compactLookupCode(normalized)

    const row = this.db.prepare(`
      SELECT p.id, p.tenant_id, p.sku, p.name, p.barcode, p.brand_id,
             (SELECT br.name FROM brands br WHERE br.id = p.brand_id AND br.tenant_id = p.tenant_id AND br.deleted_at IS NULL) AS brand_name,
             p.category_id,
             (SELECT c.name FROM categories c WHERE c.id = p.category_id AND c.tenant_id = p.tenant_id AND c.deleted_at IS NULL) AS category_name,
             p.unit, p.purchase_price, p.retail_price, p.qty_on_hand, p.reorder_point, p.notes,
             p.is_active, p.is_service, p.requires_core_return, p.core_deposit_amount,
             p.storage_bin, p.is_favorite, p.photo_url, p.specs_json, p.created_at, p.updated_at
      FROM products p
      WHERE p.tenant_id = ?
        AND p.deleted_at IS NULL
        AND p.is_active = 1
        AND (p.barcode = ? OR p.barcode = ?)
      UNION
      SELECT p.id, p.tenant_id, p.sku, p.name, p.barcode, p.brand_id,
             (SELECT br.name FROM brands br WHERE br.id = p.brand_id AND br.tenant_id = p.tenant_id AND br.deleted_at IS NULL) AS brand_name,
             p.category_id,
             (SELECT c.name FROM categories c WHERE c.id = p.category_id AND c.tenant_id = p.tenant_id AND c.deleted_at IS NULL) AS category_name,
             p.unit, p.purchase_price, p.retail_price, p.qty_on_hand, p.reorder_point, p.notes,
             p.is_active, p.is_service, p.requires_core_return, p.core_deposit_amount,
             p.storage_bin, p.is_favorite, p.photo_url, p.specs_json, p.created_at, p.updated_at
      FROM product_barcodes b
      JOIN products p ON p.id = b.product_id
      WHERE b.tenant_id = ?
        AND b.deleted_at IS NULL
        AND (b.barcode = ? OR b.barcode = ?)
        AND p.deleted_at IS NULL
        AND p.is_active = 1
      LIMIT 1
    `).get(tenantId, normalized, compact, tenantId, normalized, compact) as LocalProduct | undefined

    return row ? (this.attachAvailability([row], tenantId)[0] ?? null) : null
  }
  listProducts(options: LocalProductListOptions = {}, tenantId = DEFAULT_TENANT_ID): LocalProductListResult {
    const raw = (options.query ?? '').trim()
    const needles = productSearchNeedles(raw)
    const tokens = productSearchTokens(raw)
    const compact = compactLookupCode(raw)
    const limit = Math.max(1, Math.min(Number(options.limit ?? 100), 500))
    const offset = Math.max(0, Number(options.offset ?? 0) || 0)
    const availableQty = 'p.qty_on_hand - COALESCE(r.qty_reserved, 0)'
    const sortColumns: Record<LocalProductSortField, string> = {
      sku: 'p.sku COLLATE NOCASE',
      name: 'p.name COLLATE NOCASE',
      retail_price: 'p.retail_price',
      qty_on_hand: `(${availableQty})`,
      brand: 'br.name COLLATE NOCASE',
    }
    const sortField = options.sortField && sortColumns[options.sortField]
      ? options.sortField
      : null
    const sortDir = options.sortDir === 'desc' ? 'DESC' : 'ASC'

    const where = ['p.tenant_id = ?', 'p.deleted_at IS NULL', 'p.is_active = 1']
    const params: Array<string | number> = [tenantId]
    if (options.categoryId === '__uncategorized') {
      where.push("(p.category_id IS NULL OR p.category_id = '')")
    } else if (options.categoryId) {
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
      const indexedClauses = needles.map(() => 'p.search_text LIKE ?')
      const indexedParams = needles.map(needle => `%${needle}%`)
      if (tokens.length > 1) {
        indexedClauses.push(`(${tokens.map(() => 'p.search_text LIKE ?').join(' AND ')})`)
        indexedParams.push(...tokens.map(token => `%${token}%`))
      }
      const searchClauses = [
        ...indexedClauses,
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
        `EXISTS (
          SELECT 1 FROM product_aliases a
          WHERE a.tenant_id = p.tenant_id
            AND a.product_id = p.id
            AND a.deleted_at IS NULL
            AND (a.alias LIKE ? OR a.alias LIKE ?)
        )`,
        `EXISTS (
          SELECT 1 FROM product_cross_numbers x
          WHERE x.tenant_id = p.tenant_id
            AND x.product_id = p.id
            AND x.deleted_at IS NULL
            AND (x.cross_number = ? OR x.cross_number = ? OR x.cross_number LIKE ?)
        )`,
      ]
      const searchParams: Array<string | number> = [
        ...indexedParams,
        raw,
        compact,
        raw,
        compact,
        `%${raw}%`,
        `%${raw}%`,
        raw,
        compact,
        `%${raw}%`,
        `%${raw}%`,
        `%${compact}%`,
        raw,
        compact,
        `%${raw}%`,
      ]
      where.push(`(${searchClauses.join(' OR ')})`)
      params.push(...searchParams)
    }

    const whereSql = where.join(' AND ')
    // Наявність визначаємо ДО LIMIT/OFFSET, за тим самим доступним
    // залишком, який показуємо касиру. Інакше кожна сторінка має власну
    // групу «нема», після якої знову з'являються наявні товари.
    const orderParts: string[] = [`CASE WHEN (${availableQty}) > 0 OR p.is_service = 1 THEN 0 ELSE 1 END`]
    const dataParams = [...params]
    if (raw) {
      orderParts.push('CASE WHEN p.sku IN (?, ?) OR p.barcode IN (?, ?) THEN 0 ELSE 1 END')
      dataParams.push(raw, compact, raw, compact)
    }
    if (sortField) {
      orderParts.push(`${sortColumns[sortField]} ${sortDir}`)
    } else {
      orderParts.push('p.is_favorite DESC')
    }
    if (sortField !== 'name') orderParts.push('p.name COLLATE NOCASE ASC')
    orderParts.push('p.id ASC')

    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM products p
      WHERE ${whereSql}
    `).get(...params) as { total?: number } | undefined

    const data = this.db.prepare(`
      WITH active_reserves AS (
        SELECT product_id, SUM(qty) AS qty_reserved
        FROM stock_reserves
        WHERE tenant_id = ? AND released_at IS NULL AND deleted_at IS NULL
          AND (expires_at IS NULL OR strftime('%s', expires_at) > strftime('%s', 'now'))
        GROUP BY product_id
      ), matching_page AS MATERIALIZED (
        SELECT p.id, COALESCE(r.qty_reserved, 0) AS qty_reserved
        FROM products p
        LEFT JOIN active_reserves r ON r.product_id = p.id
        LEFT JOIN brands br ON br.id = p.brand_id AND br.tenant_id = p.tenant_id AND br.deleted_at IS NULL
        WHERE ${whereSql}
        ORDER BY ${orderParts.join(', ')}
        LIMIT ? OFFSET ?
      )
      SELECT p.id, p.tenant_id, p.sku, p.name, p.barcode,
             p.brand_id, br.name AS brand_name, p.category_id, c.name AS category_name,
             p.unit, p.purchase_price, p.retail_price, p.qty_on_hand, p.reorder_point,
             COALESCE(r.qty_reserved, 0) AS qty_reserved, (${availableQty}) AS qty_available,
             p.notes, p.is_active, p.is_service, p.requires_core_return, p.core_deposit_amount,
             p.storage_bin, p.is_favorite, p.photo_url, p.specs_json, p.created_at, p.updated_at
      FROM matching_page r
      JOIN products p ON p.id = r.id
      LEFT JOIN brands br ON br.id = p.brand_id AND br.tenant_id = p.tenant_id AND br.deleted_at IS NULL
      LEFT JOIN categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id AND c.deleted_at IS NULL
      ORDER BY ${orderParts.join(', ')}
    `).all(tenantId, ...dataParams, limit, offset, ...(raw ? [raw, compact, raw, compact] : [])) as unknown as LocalProduct[]

    return { data, total: Number(totalRow?.total ?? data.length) }
  }

  listCategories(tenantId = DEFAULT_TENANT_ID): LocalCatalogCategory[] {
    return this.db.prepare(`
      SELECT id, name, sort_order
      FROM categories
      WHERE tenant_id = ? AND deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM sync_outbox o
          WHERE o.tenant_id = categories.tenant_id
            AND o.aggregate_type = 'category'
            AND o.aggregate_id = categories.id
            AND o.operation_type = 'category.deleted'
            AND o.status <> 'synced'
        )
      ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC
    `).all(tenantId) as unknown as LocalCatalogCategory[]
  }

  listBrands(tenantId = DEFAULT_TENANT_ID): LocalCatalogBrand[] {
    return this.db.prepare(`
      SELECT id, name, country
      FROM brands
      WHERE tenant_id = ? AND deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM sync_outbox o
          WHERE o.tenant_id = brands.tenant_id
            AND o.aggregate_type = 'brand'
            AND o.aggregate_id = brands.id
            AND o.operation_type = 'brand.deleted'
            AND o.status <> 'synced'
        )
      ORDER BY name COLLATE NOCASE ASC, id ASC
    `).all(tenantId) as unknown as LocalCatalogBrand[]
  }
  createCategory(name: string, sortOrder = 0, tenantId = DEFAULT_TENANT_ID): LocalCatalogCategory {
    const cleanName = name.trim()
    if (!cleanName) throw new Error('Вкажіть назву папки')
    const existing = this.db.prepare(`
      SELECT id FROM categories
      WHERE tenant_id = ? AND deleted_at IS NULL AND lower(name) = lower(?)
      LIMIT 1
    `).get(tenantId, cleanName) as { id: string } | undefined
    if (existing) throw new Error('Така папка вже існує')
    const id = randomUUID()
    const timestamp = nowIso()
    this.db.prepare(`
      INSERT INTO categories (id, tenant_id, name, sort_order, dirty_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, tenantId, cleanName, sortOrder, timestamp, timestamp, timestamp)
    this.addCatalogOutbox('category', id, 'category.upsert', { id, name: cleanName, sort_order: sortOrder }, tenantId, timestamp)
    return { id, name: cleanName, sort_order: sortOrder }
  }

  updateCategory(id: string, name: string, tenantId = DEFAULT_TENANT_ID): LocalCatalogCategory {
    const cleanName = name.trim()
    if (!cleanName) throw new Error('Вкажіть назву папки')
    const timestamp = nowIso()
    const result = this.db.prepare(`
      UPDATE categories SET name = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).run(cleanName, timestamp, timestamp, id, tenantId)
    if (Number(result.changes) === 0) throw new Error('Папку не знайдено')
    const row = this.db.prepare('SELECT id, name, sort_order FROM categories WHERE id = ? AND tenant_id = ?')
      .get(id, tenantId) as unknown as LocalCatalogCategory
    this.addCatalogOutbox('category', id, 'category.upsert', row, tenantId, timestamp)
    return row
  }

  deleteCategory(id: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const timestamp = nowIso()
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE products SET category_id = NULL, dirty_at = ?, updated_at = ?
        WHERE tenant_id = ? AND category_id = ? AND deleted_at IS NULL
      `).run(timestamp, timestamp, tenantId, id)
      this.db.prepare(`
        UPDATE categories SET deleted_at = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(timestamp, timestamp, timestamp, id, tenantId)
      this.addCatalogOutbox('category', id, 'category.deleted', { id }, tenantId, timestamp)
    })
    return { ok: true }
  }

  createBrand(name: string, country: string | null = null, tenantId = DEFAULT_TENANT_ID): LocalCatalogBrand {
    const cleanName = name.trim()
    if (!cleanName) throw new Error('Вкажіть назву бренду')
    const existing = this.db.prepare(`
      SELECT id FROM brands
      WHERE tenant_id = ? AND deleted_at IS NULL AND lower(name) = lower(?)
      LIMIT 1
    `).get(tenantId, cleanName) as { id: string } | undefined
    if (existing) throw new Error('Такий бренд вже існує')
    const id = randomUUID()
    const timestamp = nowIso()
    this.db.prepare(`
      INSERT INTO brands (id, tenant_id, name, country, dirty_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, tenantId, cleanName, country, timestamp, timestamp, timestamp)
    const row = { id, name: cleanName, country }
    this.addCatalogOutbox('brand', id, 'brand.upsert', row, tenantId, timestamp)
    return row
  }

  updateBrand(id: string, input: { name?: string; country?: string | null }, tenantId = DEFAULT_TENANT_ID): LocalCatalogBrand {
    const current = this.db.prepare(`
      SELECT id, name, country FROM brands
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).get(id, tenantId) as unknown as LocalCatalogBrand | undefined
    if (!current) throw new Error('Бренд не знайдено')
    const next = { id, name: input.name?.trim() || current.name, country: input.country !== undefined ? input.country : current.country }
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE brands SET name = ?, country = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(next.name, next.country, timestamp, timestamp, id, tenantId)
    this.addCatalogOutbox('brand', id, 'brand.upsert', next, tenantId, timestamp)
    return next
  }

  deleteBrand(id: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const timestamp = nowIso()
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE products SET brand_id = NULL, dirty_at = ?, updated_at = ?
        WHERE tenant_id = ? AND brand_id = ? AND deleted_at IS NULL
      `).run(timestamp, timestamp, tenantId, id)
      this.db.prepare(`
        UPDATE brands SET deleted_at = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(timestamp, timestamp, timestamp, id, tenantId)
      this.addCatalogOutbox('brand', id, 'brand.deleted', { id }, tenantId, timestamp)
    })
    return { ok: true }
  }

  generateBarcodeOnly(tenantId = DEFAULT_TENANT_ID): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const body = `200${String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0')}`
      const digits = body.split('').map(Number)
      const sum = digits.reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3), 0)
      const barcode = `${body}${(10 - (sum % 10)) % 10}`
      if (!this.findByBarcode(barcode, tenantId)) return barcode
    }
    throw new Error('Не вдалося згенерувати унікальний штрихкод')
  }
  listStaff(tenantId = DEFAULT_TENANT_ID): any[] {
    return (this.db.prepare(`
      SELECT id, full_name, role, phone, is_active, base_rate, rate_period, created_at
      FROM staff_users
      WHERE tenant_id = ? AND deleted_at IS NULL
      ORDER BY is_active DESC, full_name COLLATE NOCASE ASC
    `).all(tenantId) as any[]).map((row) => ({
      ...row,
      email: '',
      is_active: row.is_active === 1,
      base_rate: Number(row.base_rate ?? 0),
      rate_period: row.rate_period === 'month' ? 'month' : 'day',
    }))
  }

  getSettings(): any {
    const defaults = {
      id: 'local-shop',
      shop_name: 'Forsage',
      shop_address: null,
      phone: null,
      max_discount_pct: 100,
      allow_negative_qty: false,
      return_days: 14,
      currency: 'UAH',
      default_debt_limit_kopecks: 0,
      quick_percents: [20, 30, 50],
      markup_rules: [],
      category_markups: [],
      price_tiers: [{ id: 'default', name: 'Звичайна ціна', discount_pct: 0, is_default: true, sort_order: 0, created_at: '' }],
      price_rounding_enabled: false,
      price_rounding_step: 100,
      price_rounding_dir: 'nearest',
      employee_discount_pct: 0,
      vin_decoder_url: null,
      vin_decoder_api_key: null,
      auto_print_receipt: false,
      receipt_width_mm: 58,
      owner_telegram_chat_id: null,
      prro_enabled: false,
      prro_provider: 'kashalot',
      kashalot_license_key: null,
      kashalot_pin: null,
      bank_terminal_enabled: false,
      terminal_provider: 'mock',
      privatbank_terminal_ip: null,
      privatbank_terminal_port: null,
      privatbank_merchant_id: null,
    }
    const row = this.db.prepare("SELECT value_json FROM app_meta WHERE key = 'shop_settings'")
      .get() as { value_json: string } | undefined
    if (!row) return defaults
    try {
      return { ...defaults, ...JSON.parse(row.value_json) }
    } catch {
      return defaults
    }
  }

  updateSettings(input: any, tenantId = DEFAULT_TENANT_ID): any {
    const timestamp = nowIso()
    const transientKeys = new Set([
      'price_tier_upserts',
      'price_tier_deleted_ids',
      'category_markup_upserts',
      'category_markup_deleted_ids',
    ])
    const persistentInput = Object.fromEntries(
      Object.entries(input ?? {}).filter(([key]) => !transientKeys.has(key)),
    )
    const settings = { ...this.getSettings(), ...persistentInput, id: 'local-shop' }
    this.db.prepare(`
      INSERT INTO app_meta(key, value_json, updated_at)
      VALUES ('shop_settings', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(settings), timestamp)
    // Синхронізуємо лише змінені поля. Повна застаріла копія налаштувань
    // не повинна перезаписувати нові значення, збережені у веб-версії.
    this.addCatalogOutbox('settings', 'shop', 'settings.updated', input, tenantId, timestamp)
    return settings
  }
  // Усі підбори використовують той самий порядок, що й повний каталог.
  listPopular(tenantId = DEFAULT_TENANT_ID, limit = 50): LocalProduct[] {
    return this.listProducts({ limit }, tenantId).data
  }

  searchProducts(query: string, tenantId = DEFAULT_TENANT_ID, limit = 20): LocalProduct[] {
    const raw = query.trim()
    if (!raw) return []

    const exact = this.findByBarcode(raw, tenantId)
    if (exact) return [exact]

    return this.listProducts({ query: raw, limit }, tenantId).data
  }
  private attachAvailability(products: LocalProduct[], tenantId: string): LocalProduct[] {
    if (products.length === 0) return products
    const productIds = [...new Set(products.map((product) => product.id))]
    const placeholders = productIds.map(() => '?').join(',')
    const reserveRows = this.db.prepare(
      `SELECT product_id, COALESCE(SUM(qty), 0) AS qty_reserved
       FROM stock_reserves
       WHERE tenant_id = ?
         AND product_id IN (${placeholders})
         AND released_at IS NULL
         AND deleted_at IS NULL
         AND (expires_at IS NULL OR strftime('%s', expires_at) > strftime('%s', 'now'))
       GROUP BY product_id`,
    ).all(tenantId, ...productIds) as Array<{ product_id: string; qty_reserved: number }>
    const reservedByProduct = new Map(
      reserveRows.map((row) => [row.product_id, Number(row.qty_reserved ?? 0)]),
    )
    return products.map((product) => {
      const qtyReserved = reservedByProduct.get(product.id) ?? 0
      return {
        ...product,
        qty_reserved: qtyReserved,
        qty_available: Number(product.qty_on_hand ?? 0) - qtyReserved,
      }
    })
  }
  private addCatalogOutbox(
    aggregateType: 'category' | 'brand' | 'settings',
    aggregateId: string,
    operationType: string,
    payload: unknown,
    tenantId: string,
    timestamp: string,
  ): void {
    this.db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(randomUUID(), tenantId, this.db.deviceId, aggregateType, aggregateId, operationType, JSON.stringify(payload), timestamp)
  }
  private normalizeProductReferences(input: LocalProductUpsert, tenantId: string): LocalProductUpsert {
    const brandId = input.brand_id?.trim()
    const categoryId = input.category_id?.trim()
    return {
      ...input,
      brand_id: brandId && this.referenceExists('brands', brandId, tenantId) ? brandId : null,
      category_id: categoryId && this.referenceExists('categories', categoryId, tenantId) ? categoryId : null,
    }
  }
  private referenceExists(table: 'brands' | 'categories', id: string, tenantId: string): boolean {
    const row = this.db.prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1`).get(id, tenantId)
    return Boolean(row)
  }

  private addProductOutbox(operationType: 'product.upsert' | 'product.deleted', productId: string, payload: LocalProductUpsert): void {
    const timestamp = nowIso()
    const tenantId = payload.tenant_id ?? DEFAULT_TENANT_ID
    if (operationType === 'product.upsert' && payload.stock_correction !== true) {
      const existing = this.db.prepare(`
        SELECT sequence FROM sync_outbox
        WHERE tenant_id = ? AND aggregate_type = 'product' AND aggregate_id = ?
          AND operation_type = 'product.upsert'
          AND status IN ('pending', 'failed')
          AND COALESCE(json_extract(payload_json, '$.stock_correction'), 0) <> 1
        ORDER BY sequence DESC LIMIT 1
      `).get(tenantId, productId) as { sequence: number } | undefined
      if (existing) {
        this.db.prepare(`
          UPDATE sync_outbox
          SET payload_json = ?, status = 'pending', attempts = 0,
              next_attempt_at = NULL, last_error = NULL, created_at = ?
          WHERE sequence = ?
        `).run(JSON.stringify(payload), timestamp, existing.sequence)
        return
      }
    }

    this.db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, created_at
      )
      VALUES (?, ?, ?, 'product', ?, ?, ?, 'pending', ?)
    `).run(
      randomUUID(), tenantId, this.db.deviceId, productId,
      operationType, JSON.stringify(payload), timestamp,
    )
  }
}
