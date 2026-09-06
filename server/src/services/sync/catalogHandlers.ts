/**
 * Винесено з `syncService.ts` без зміни поведінки — див. `REFACTOR_PLAN.md`,
 * ітерація 4. У файлі на 4900 рядків помилку не видно очима.
 */

import { runTransaction } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import { normalizeOemValue } from '../../validators/productValidator.js'
import { buildProductSyncQueryValues } from '../syncProductValues.js'
import { isUuid } from './syncCore.js'
import type { SyncOutboxOperation } from './syncCore.js'
import { assertProductReferenceExists } from './syncGuards.js'
import { randomUUID } from 'node:crypto'

export async function applyCategoryUpsert(tenantId: string, operation: SyncOutboxOperation, role: string): Promise<void> {
  const payload = operation.payload ?? {}
  const categoryId = String(payload.id ?? operation.aggregate_id)
  const name = String(payload.name ?? '').trim()
  if (!isUuid(categoryId) || !name) {
    throw new AppError('SYNC_CATEGORY_INVALID', 'Категорія має містити коректні id і назву', 400)
  }
  const parentId = isUuid(payload.parent_id) && payload.parent_id !== categoryId ? payload.parent_id : null
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at

  await runTransaction(async (client) => {
    if (!['owner', 'admin'].includes(role)) {
      const existing = await client.query(
        'SELECT id FROM categories WHERE id = $1 AND tenant_id = $2 LIMIT 1 FOR UPDATE',
        [categoryId, tenantId],
      )
      if (existing.rowCount) {
        throw new AppError('FORBIDDEN', 'Змінювати існуючі категорії може тільки власник або адміністратор', 403)
      }
    }
    await client.query(
      `INSERT INTO categories (
         id, tenant_id, parent_id, name, sort_order, created_at, updated_at, deleted_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
       ON CONFLICT (id) DO UPDATE SET
         parent_id = EXCLUDED.parent_id,
         name = EXCLUDED.name,
         sort_order = EXCLUDED.sort_order,
         updated_at = EXCLUDED.updated_at,
         deleted_at = NULL
       WHERE categories.tenant_id = EXCLUDED.tenant_id`,
      [categoryId, tenantId, parentId, name, Number(payload.sort_order ?? 0), createdAt, appliedAt],
    )
  })
}

export async function applyCategoryDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `UPDATE products
       SET category_id = NULL, updated_at = $3
       WHERE tenant_id = $1 AND category_id = $2`,
      [tenantId, operation.aggregate_id, appliedAt],
    )
    await client.query(
      `UPDATE categories SET parent_id = NULL, updated_at = $3
       WHERE tenant_id = $1 AND parent_id = $2 AND deleted_at IS NULL`,
      [tenantId, operation.aggregate_id, appliedAt],
    )
    await client.query(
      'UPDATE volume_discounts SET category_id = NULL WHERE tenant_id = $1 AND category_id = $2',
      [tenantId, operation.aggregate_id],
    )
    await client.query(
      'DELETE FROM category_markups WHERE tenant_id = $1 AND category_id = $2',
      [tenantId, operation.aggregate_id],
    )
    await client.query(
      'UPDATE commission_rules SET category_id = NULL, updated_at = $3 WHERE tenant_id = $1 AND category_id = $2',
      [tenantId, operation.aggregate_id, appliedAt],
    )
    await client.query(
      `UPDATE categories
       SET parent_id = NULL, deleted_at = $3, updated_at = $3
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [operation.aggregate_id, tenantId, appliedAt],
    )
  })
}

export async function applyBrandUpsert(tenantId: string, operation: SyncOutboxOperation, role: string): Promise<void> {
  const payload = operation.payload ?? {}
  const brandId = String(payload.id ?? operation.aggregate_id)
  const name = String(payload.name ?? '').trim()
  if (!isUuid(brandId) || !name) {
    throw new AppError('SYNC_BRAND_INVALID', 'Бренд має містити коректні id і назву', 400)
  }
  const tier = ['original', 'premium', 'standard', 'budget'].includes(String(payload.tier))
    ? String(payload.tier)
    : 'standard'
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at

  await runTransaction(async (client) => {
    if (!['owner', 'admin'].includes(role)) {
      const existing = await client.query(
        'SELECT id FROM brands WHERE id = $1 AND tenant_id = $2 LIMIT 1 FOR UPDATE',
        [brandId, tenantId],
      )
      if (existing.rowCount) {
        throw new AppError('FORBIDDEN', 'Змінювати існуючі бренди може тільки власник або адміністратор', 403)
      }
    }
    await client.query(
      `INSERT INTO brands (
         id, tenant_id, name, country, tier, created_at, updated_at, deleted_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         country = EXCLUDED.country,
         tier = EXCLUDED.tier,
         updated_at = EXCLUDED.updated_at,
         deleted_at = NULL
       WHERE brands.tenant_id = EXCLUDED.tenant_id`,
      [brandId, tenantId, name, payload.country ?? null, tier, createdAt, appliedAt],
    )
  })
}

export async function applyBrandDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `UPDATE products
       SET brand_id = NULL, updated_at = $3
       WHERE tenant_id = $1 AND brand_id = $2 AND deleted_at IS NULL`,
      [tenantId, operation.aggregate_id, appliedAt],
    )
    await client.query(
      'UPDATE commission_rules SET brand_id = NULL, updated_at = $3 WHERE tenant_id = $1 AND brand_id = $2',
      [tenantId, operation.aggregate_id, appliedAt],
    )
    await client.query(
      `UPDATE brands
       SET deleted_at = $3, updated_at = $3
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [operation.aggregate_id, tenantId, appliedAt],
    )
  })
}

export async function applyProductUpsert(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const productId = String(payload.id ?? operation.aggregate_id)
  if (!isUuid(productId)) {
    throw new AppError('SYNC_PRODUCT_INVALID', 'Товар має містити коректний id', 400)
  }

  await runTransaction(async (client) => {
    const existingResult = await client.query(
      `SELECT id, sku, name, barcode, brand_id, category_id, unit,
              purchase_price, retail_price, qty_on_hand, reorder_point, notes,
              is_active, is_service, requires_core_return, core_deposit_amount,
              storage_bin, is_favorite, photo_url, specs, additional_barcodes
       FROM products
       WHERE id = $1 AND tenant_id = $2
       LIMIT 1`,
      [productId, tenantId],
    )
    const existing = existingResult.rows[0] ?? null
    const owns = (key: string): boolean => Object.prototype.hasOwnProperty.call(payload, key)
    const fromPayload = (key: string, fallback: any): any => owns(key) ? payload[key] : fallback
    const toNumber = (value: any, fallback = 0): number => {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }
    const toMoney = (value: any, fallback: number, field: string): number => {
      const parsed = Math.round(toNumber(value, fallback))
      if (parsed < 0 || parsed > 2_147_483_647) {
        throw new AppError('SYNC_PRODUCT_PRICE_INVALID', `${field} має містити коректну суму`, 422)
      }
      return parsed
    }

    const sku = String(fromPayload('sku', existing?.sku ?? '') ?? '').trim()
    const name = String(fromPayload('name', existing?.name ?? '') ?? '').trim()
    if (!sku || !name) {
      throw new AppError('SYNC_PRODUCT_INVALID', 'Новий товар має містити артикул і назву', 400)
    }

    const barcodesTouched = owns('barcode') || owns('additional_barcodes')
    const currentBarcodeRows = barcodesTouched && existing
      ? (await client.query(
        `SELECT barcode, is_primary
         FROM product_barcodes
         WHERE tenant_id = $1 AND product_id = $2
         ORDER BY is_primary DESC, created_at ASC`,
        [tenantId, productId],
      )).rows
      : []
    const currentAdditional = [
      ...(Array.isArray(existing?.additional_barcodes) ? existing.additional_barcodes : []),
      ...currentBarcodeRows.filter((row: any) => row.is_primary !== true).map((row: any) => row.barcode),
    ]
    const primaryBarcodeValue = fromPayload('barcode', existing?.barcode ?? null)
    const primaryBarcode = typeof primaryBarcodeValue === 'string' && primaryBarcodeValue.trim()
      ? primaryBarcodeValue.trim()
      : null
    const requestedAdditional = owns('additional_barcodes')
      ? (Array.isArray(payload.additional_barcodes) ? payload.additional_barcodes : [])
      : currentAdditional
    const additionalBarcodes = [...new Set(requestedAdditional
      .filter((barcode: any): barcode is string => typeof barcode === 'string' && barcode.trim().length > 0)
      .map((barcode: string) => barcode.trim())
      .filter((barcode: string) => barcode !== primaryBarcode))]
    const barcodes = [...new Set([primaryBarcode, ...additionalBarcodes].filter((barcode): barcode is string => Boolean(barcode)))]

    const requestedPhotoUrl = fromPayload('photo_url', existing?.photo_url ?? null)
    const photoUrl = typeof requestedPhotoUrl === 'string' && /^file:/i.test(requestedPhotoUrl)
      ? existing?.photo_url ?? null
      : requestedPhotoUrl

    const updatedAt = operation.applied_at ?? operation.created_at
    const brandId = fromPayload('brand_id', existing?.brand_id ?? null) || null
    const categoryId = fromPayload('category_id', existing?.category_id ?? null) || null
    // A missing reference used to surface as a raw `products_brand_id_fkey`
    // violation, which says nothing to the cashier watching the queue and hides
    // the fact that the fix is simply to let the brand through first. The
    // reference always precedes the product in the outbox, so retrying works.
    await assertProductReferenceExists(client, tenantId, 'brands', brandId, 'Бренд')
    await assertProductReferenceExists(client, tenantId, 'categories', categoryId, 'Категорію')
    const productValues = [
      productId,
      tenantId,
      sku,
      name,
      primaryBarcode,
      brandId,
      categoryId,
      String(fromPayload('unit', existing?.unit ?? 'шт') ?? 'шт'),
      toMoney(fromPayload('purchase_price', existing?.purchase_price ?? 0), Number(existing?.purchase_price ?? 0), 'Ціна закупівлі'),
      toMoney(fromPayload('retail_price', existing?.retail_price ?? 0), Number(existing?.retail_price ?? 0), 'Ціна продажу'),
      toNumber(fromPayload('qty_on_hand', existing?.qty_on_hand ?? 0)),
      toNumber(fromPayload('reorder_point', existing?.reorder_point ?? 0)),
      fromPayload('notes', existing?.notes ?? null),
      fromPayload('is_active', existing?.is_active ?? true) !== false,
      fromPayload('is_service', existing?.is_service ?? false) === true,
      fromPayload('requires_core_return', existing?.requires_core_return ?? false) === true,
      toMoney(fromPayload('core_deposit_amount', existing?.core_deposit_amount ?? 0), Number(existing?.core_deposit_amount ?? 0), 'Застава'),
      fromPayload('storage_bin', existing?.storage_bin ?? null),
      fromPayload('is_favorite', existing?.is_favorite ?? false) === true,
      photoUrl,
      fromPayload('specs', existing?.specs ?? {}),
      JSON.stringify(additionalBarcodes),
      updatedAt,
    ]
    const { insertValues, updateValues } = buildProductSyncQueryValues(
      productValues,
      payload.stock_correction === true,
    )

    if (existing) {
      await client.query(
        `UPDATE products SET
          sku = $3, name = $4, barcode = $5, brand_id = $6, category_id = $7,
          unit = $8, purchase_price = $9, retail_price = $10,
          qty_on_hand = CASE WHEN $24::boolean THEN $11::numeric ELSE products.qty_on_hand END,
          reorder_point = $12, notes = $13, is_active = $14, is_service = $15,
          requires_core_return = $16, core_deposit_amount = $17,
          storage_bin = $18, is_favorite = $19, photo_url = $20, specs = $21,
          additional_barcodes = $22::jsonb, deleted_at = NULL, updated_at = $23
        WHERE id = $1 AND tenant_id = $2`,
        updateValues,
      )
    } else {
      await client.query(
        `INSERT INTO products (
          id, tenant_id, sku, name, barcode, brand_id, category_id, unit,
          purchase_price, retail_price, qty_on_hand, reorder_point, notes,
          is_active, is_service, requires_core_return, core_deposit_amount,
          storage_bin, is_favorite, photo_url, specs, additional_barcodes,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11::numeric, $12, $13,
          $14, $15, $16, $17,
          $18, $19, $20, $21, $22::jsonb,
          $23, $23
        )`,
        insertValues,
      )
    }

    // Крос-номери/аналоги з картки товару (офлайн-desktop → сервер): повний список замінює наявні.
    if (owns('cross_numbers')) {
      const list = Array.isArray(payload.cross_numbers) ? payload.cross_numbers : []
      const uniqueCross = new Map<string, string>()
      for (const raw of list) {
        const num = String(raw ?? '').trim()
        const norm = normalizeOemValue(num)
        if (norm) uniqueCross.set(norm, num)
      }
      const normalizedCrossNumbers = [...uniqueCross.keys()]
      await client.query(
        `UPDATE product_cross_numbers
         SET deleted_at = $4, updated_at = $4
         WHERE product_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
           AND NOT (normalized_number = ANY($3::text[]))`,
        [productId, tenantId, normalizedCrossNumbers, updatedAt],
      )
      for (const [norm, num] of uniqueCross) {
        await client.query(
          `INSERT INTO product_cross_numbers (
             tenant_id, product_id, number, normalized_number, number_type,
             source, is_verified, updated_at, deleted_at
           ) VALUES ($1, $2, $3, $4, 'cross', 'Картка товару', true, $5, NULL)
           ON CONFLICT (tenant_id, product_id, normalized_number) DO UPDATE SET
             number = EXCLUDED.number,
             number_type = EXCLUDED.number_type,
             source = EXCLUDED.source,
             is_verified = EXCLUDED.is_verified,
             updated_at = EXCLUDED.updated_at,
             deleted_at = NULL`,
          [tenantId, productId, num, norm, updatedAt],
        )
      }
    }

    if (!barcodesTouched) return

    for (const barcode of barcodes) {
      const duplicateFromIndex = await client.query(
        `SELECT p.name, p.sku
         FROM product_barcodes b
         JOIN products p ON p.id = b.product_id AND p.tenant_id = b.tenant_id
         WHERE b.tenant_id = $1
           AND b.barcode = $2
           AND b.product_id <> $3
           AND b.deleted_at IS NULL
           AND p.deleted_at IS NULL
         LIMIT 1`,
        [tenantId, barcode, productId],
      )
      const duplicateFromProduct = duplicateFromIndex.rowCount
        ? duplicateFromIndex
        : await client.query(
          `SELECT name, sku
           FROM products
           WHERE tenant_id = $1
             AND barcode = $2
             AND deleted_at IS NULL
             AND id <> $3
           LIMIT 1`,
          [tenantId, barcode, productId],
        )
      if (duplicateFromProduct.rowCount) {
        const duplicate = duplicateFromProduct.rows[0]
        throw new AppError(
          'BARCODE_TAKEN',
          `Штрихкод "${barcode}" вже у товару "${duplicate.name || duplicate.sku || 'іншого товару'}"`,
          409,
        )
      }
    }

    await client.query(
      `UPDATE product_barcodes
       SET deleted_at = $4, updated_at = $4
       WHERE product_id = $1
         AND tenant_id = $2
         AND deleted_at IS NULL
         AND NOT (barcode = ANY($3::text[]))`,
      [productId, tenantId, barcodes, updatedAt],
    )

    for (const barcode of barcodes) {
      await client.query(
        `INSERT INTO product_barcodes (
          id, tenant_id, product_id, barcode, barcode_type, is_primary,
          created_at, updated_at, deleted_at
        ) VALUES ($1, $2, $3, $4, 'ean13', $5, $6, $6, NULL)
        ON CONFLICT (tenant_id, barcode) DO UPDATE SET
          product_id = EXCLUDED.product_id,
          barcode_type = EXCLUDED.barcode_type,
          is_primary = EXCLUDED.is_primary,
          updated_at = EXCLUDED.updated_at,
          deleted_at = NULL
        WHERE product_barcodes.product_id = EXCLUDED.product_id
           OR product_barcodes.deleted_at IS NOT NULL`,
        [randomUUID(), tenantId, productId, barcode, barcode === primaryBarcode, updatedAt],
      )
    }
  })
}

export async function applyProductDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const deletedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `UPDATE products
       SET deleted_at = $3, is_active = false, updated_at = $3
       WHERE id = $1 AND tenant_id = $2`,
      [operation.aggregate_id, tenantId, deletedAt],
    )
    for (const table of ['product_barcodes', 'product_aliases', 'product_cross_numbers']) {
      await client.query(
        `UPDATE ${table}
         SET deleted_at = $3, updated_at = $3
         WHERE product_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [operation.aggregate_id, tenantId, deletedAt],
      )
    }
  })
}
