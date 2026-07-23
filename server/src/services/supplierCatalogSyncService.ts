import type pg from 'pg'
import { runTransaction } from '../db/pg.js'
import { normalizeExactBarcode, normalizeExactProductName } from '../lib/productIdentity.js'
import { AppError } from '../middleware/errorHandler.js'

type SupplierCatalogOperation = {
  aggregate_id: string
  payload?: any
  applied_at?: string
  created_at: string
}

type CatalogItem = {
  id: string
  supplier_id: string | null
  sku: string
  barcode: string | null
  brand: string | null
  name: string
  price_kopecks: number
  qty: string
  warehouse_name: string | null
  created_at: string
  updated_at: string
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function cleanScope(value: unknown): string | null {
  const clean = String(value ?? '').trim()
  return clean || null
}

function normalizeSku(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().toLocaleUpperCase('uk-UA')
}

function normalizeItem(raw: any, fallbackId: unknown, timestamp: string): CatalogItem {
  const id = String(raw?.id ?? fallbackId ?? '')
  if (!isUuid(id)) throw new AppError('SYNC_SUPPLIER_CATALOG_INVALID', 'Некоректний ID чернової позиції', 400)
  const name = String(raw?.name ?? '').trim()
  if (!name) throw new AppError('SYNC_SUPPLIER_CATALOG_INVALID', 'Назва чернової позиції обов’язкова', 400)
  const sku = normalizeSku(raw?.sku)
  if (!sku) throw new AppError('SYNC_SUPPLIER_CATALOG_INVALID', 'Артикул чернової позиції обов’язковий', 400)
  const quantity = Number.parseFloat(String(raw?.qty ?? '0').replace(',', '.'))
  return {
    id,
    supplier_id: isUuid(raw?.supplier_id) ? raw.supplier_id : null,
    sku,
    barcode: normalizeExactBarcode(raw?.barcode),
    brand: cleanScope(raw?.brand),
    name,
    price_kopecks: Math.max(0, Math.round(Number(raw?.price_kopecks) || 0)),
    qty: String(Number.isFinite(quantity) && quantity >= 0 ? quantity : 0),
    warehouse_name: cleanScope(raw?.warehouse_name),
    created_at: String(raw?.created_at ?? timestamp),
    updated_at: timestamp,
  }
}

function identityConflict(incoming: CatalogItem, existing: CatalogItem[]): CatalogItem | null {
  const barcode = normalizeExactBarcode(incoming.barcode)
  const sku = normalizeSku(incoming.sku)
  const name = normalizeExactProductName(incoming.name)
  const byBarcode = barcode
    ? existing.filter((item) => normalizeExactBarcode(item.barcode) === barcode)
    : []
  const bySku = sku ? existing.filter((item) => normalizeSku(item.sku) === sku) : []
  if (byBarcode.length > 1) {
    throw new AppError('SYNC_SUPPLIER_CATALOG_CONFLICT', `Штрихкод «${barcode}» дублюється у прайсі постачальника`, 409)
  }
  if (bySku.length > 1) {
    throw new AppError('SYNC_SUPPLIER_CATALOG_CONFLICT', `Артикул «${sku}» дублюється у прайсі постачальника`, 409)
  }
  if (byBarcode[0] && bySku[0] && byBarcode[0].id !== bySku[0].id) {
    throw new AppError('SYNC_SUPPLIER_CATALOG_CONFLICT', 'Штрихкод і артикул вказують на різні чернові позиції', 409)
  }
  const identifier = byBarcode[0] ?? bySku[0]
  if (identifier) return identifier
  const byName = existing.filter((item) => normalizeExactProductName(item.name) === name)
  if (byName.length > 1) {
    throw new AppError('SYNC_SUPPLIER_CATALOG_CONFLICT', `Повна назва «${incoming.name}» дублюється у прайсі постачальника`, 409)
  }
  return byName[0] ?? null
}

export function validateSupplierCatalogIdentityRows(rows: any[]): void {
  const timestamp = new Date(0).toISOString()
  const accepted: CatalogItem[] = []
  for (const row of rows) {
    const item = normalizeItem(row, row?.id, timestamp)
    const duplicate = identityConflict(item, accepted)
    if (duplicate) {
      throw new AppError(
        'SYNC_SUPPLIER_CATALOG_DUPLICATE',
        `Рядок «${item.name}» вже існує як «${duplicate.name}»`,
        409,
      )
    }
    accepted.push(item)
  }
}

async function assertSupplier(client: pg.PoolClient, tenantId: string, supplierId: string | null): Promise<void> {
  if (!supplierId) return
  const result = await client.query(
    'SELECT 1 FROM suppliers WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1',
    [supplierId, tenantId],
  )
  if (result.rowCount === 0) throw new AppError('SUPPLIER_NOT_FOUND', 'Постачальника не знайдено', 404)
}

async function loadScope(
  client: pg.PoolClient,
  tenantId: string,
  supplierId: string | null,
  warehouseName: string | null,
): Promise<CatalogItem[]> {
  const result = await client.query(
    `SELECT id, supplier_id, sku, barcode, brand, name, price_kopecks, qty,
            warehouse_name, created_at, updated_at
     FROM supplier_price_items
     WHERE tenant_id = $1
       AND supplier_id IS NOT DISTINCT FROM $2::uuid
       AND warehouse_name IS NOT DISTINCT FROM $3::text
       AND deleted_at IS NULL
     FOR UPDATE`,
    [tenantId, supplierId, warehouseName],
  )
  return result.rows as CatalogItem[]
}

async function upsertItems(client: pg.PoolClient, tenantId: string, items: CatalogItem[]): Promise<void> {
  const batchSize = 400
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize)
    const values: unknown[] = []
    const tuples = batch.map((item, index) => {
      const offset = index * 13
      values.push(
        item.id, tenantId, item.supplier_id, item.sku, item.barcode, item.brand,
        item.name, item.price_kopecks, item.qty, item.warehouse_name,
        item.created_at, item.updated_at, null,
      )
      return `(${Array.from({ length: 13 }, (_, column) => `$${offset + column + 1}`).join(',')})`
    })
    await client.query(
      `INSERT INTO supplier_price_items (
        id, tenant_id, supplier_id, sku, barcode, brand, name, price_kopecks,
        qty, warehouse_name, created_at, updated_at, deleted_at
      ) VALUES ${tuples.join(',')}
      ON CONFLICT (id) DO UPDATE SET
        supplier_id = EXCLUDED.supplier_id,
        sku = EXCLUDED.sku,
        barcode = EXCLUDED.barcode,
        brand = EXCLUDED.brand,
        name = EXCLUDED.name,
        price_kopecks = EXCLUDED.price_kopecks,
        qty = EXCLUDED.qty,
        warehouse_name = EXCLUDED.warehouse_name,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL
      WHERE supplier_price_items.tenant_id = EXCLUDED.tenant_id`,
      values,
    )
  }
}

export async function applySupplierCatalogItemUpsert(
  tenantId: string,
  operation: SupplierCatalogOperation,
): Promise<void> {
  const timestamp = operation.applied_at ?? new Date().toISOString()
  const item = normalizeItem(operation.payload, operation.aggregate_id, timestamp)
  await runTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`supplier-catalog:${tenantId}`])
    await assertSupplier(client, tenantId, item.supplier_id)
    const scope = (await loadScope(client, tenantId, item.supplier_id, item.warehouse_name))
      .filter((existing) => existing.id !== item.id)
    const duplicate = identityConflict(item, scope)
    if (duplicate) {
      throw new AppError(
        'SYNC_SUPPLIER_CATALOG_DUPLICATE',
        `Чернова позиція вже існує як «${duplicate.name}». Оновіть або видаліть дубль.`,
        409,
        { existing_id: duplicate.id },
      )
    }
    await upsertItems(client, tenantId, [item])
  })
}

export async function applySupplierCatalogItemDeleted(
  tenantId: string,
  operation: SupplierCatalogOperation,
): Promise<void> {
  const id = String(operation.payload?.id ?? operation.aggregate_id ?? '')
  if (!isUuid(id)) throw new AppError('SYNC_SUPPLIER_CATALOG_INVALID', 'Некоректний ID чернової позиції', 400)
  const timestamp = operation.applied_at ?? new Date().toISOString()
  await runTransaction(async (client) => {
    await client.query(
      `UPDATE supplier_price_items
       SET deleted_at = COALESCE(deleted_at, $1), updated_at = $1
       WHERE id = $2 AND tenant_id = $3`,
      [timestamp, id, tenantId],
    )
  })
}

export async function applySupplierCatalogImported(
  tenantId: string,
  operation: SupplierCatalogOperation,
): Promise<void> {
  const timestamp = operation.applied_at ?? new Date().toISOString()
  const payload = operation.payload ?? {}
  const importRecord = payload.import ?? {}
  const importId = String(importRecord.id ?? operation.aggregate_id ?? '')
  if (!isUuid(importId)) throw new AppError('SYNC_SUPPLIER_CATALOG_INVALID', 'Некоректний ID імпорту', 400)
  if (!Array.isArray(payload.items) || payload.items.length > 50_000) {
    throw new AppError('SYNC_SUPPLIER_CATALOG_INVALID', 'Некоректний або завеликий список позицій імпорту', 400)
  }
  const mode = payload.mode === 'replace' ? 'replace' : 'add'
  const supplierId = isUuid(importRecord.supplier_id) ? importRecord.supplier_id : null
  const warehouseName = cleanScope(payload.warehouse_name)
  const items = payload.items.map((item: any) => normalizeItem({
    ...item,
    supplier_id: supplierId,
    warehouse_name: warehouseName,
  }, item?.id, timestamp))

  await runTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`supplier-catalog:${tenantId}`])
    await assertSupplier(client, tenantId, supplierId)
    if (mode === 'replace') {
      await client.query(
        `UPDATE supplier_price_items
         SET deleted_at = COALESCE(deleted_at, $1), updated_at = $1
         WHERE tenant_id = $2
           AND supplier_id IS NOT DISTINCT FROM $3::uuid
           AND warehouse_name IS NOT DISTINCT FROM $4::text
           AND deleted_at IS NULL`,
        [timestamp, tenantId, supplierId, warehouseName],
      )
    }

    const scope = mode === 'add'
      ? await loadScope(client, tenantId, supplierId, warehouseName)
      : []
    for (const item of items) {
      const withoutSelf = scope.filter((existing) => existing.id !== item.id)
      const duplicate = identityConflict(item, withoutSelf)
      if (duplicate) {
        throw new AppError(
          'SYNC_SUPPLIER_CATALOG_DUPLICATE',
          `Рядок «${item.name}» вже існує як «${duplicate.name}». Виправте конфлікт у черновому прайсі.`,
          409,
          { incoming_id: item.id, existing_id: duplicate.id },
        )
      }
      const existingIndex = scope.findIndex((existing) => existing.id === item.id)
      if (existingIndex >= 0) scope[existingIndex] = item
      else scope.push(item)
    }
    await upsertItems(client, tenantId, items)

    await client.query(
      `INSERT INTO supplier_price_imports (
        id, tenant_id, supplier_id, filename, status, total_rows, processed_rows,
        errors_log, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
      ON CONFLICT (id) DO UPDATE SET
        supplier_id = EXCLUDED.supplier_id,
        filename = EXCLUDED.filename,
        status = EXCLUDED.status,
        total_rows = EXCLUDED.total_rows,
        processed_rows = EXCLUDED.processed_rows,
        errors_log = EXCLUDED.errors_log,
        updated_at = EXCLUDED.updated_at
      WHERE supplier_price_imports.tenant_id = EXCLUDED.tenant_id`,
      [
        importId,
        tenantId,
        supplierId,
        String(importRecord.filename ?? 'import.csv'),
        ['pending', 'processing', 'completed', 'failed'].includes(importRecord.status)
          ? importRecord.status
          : 'completed',
        Math.max(0, Math.round(Number(importRecord.total_rows) || items.length)),
        Math.max(0, Math.round(Number(importRecord.processed_rows) || items.length)),
        JSON.stringify(Array.isArray(importRecord.errors_log) ? importRecord.errors_log : []),
        String(importRecord.created_at ?? timestamp),
        timestamp,
      ],
    )
  })
}
