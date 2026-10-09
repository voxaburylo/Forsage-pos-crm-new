import type pg from 'pg'
import { catalogPriceKopecks, catalogQuantity } from '../lib/supplierCatalogNumbers.js'
import { runTransaction } from '../db/pg.js'
import { normalizeExactBarcode, normalizeExactProductName } from '../lib/productIdentity.js'
import { AppError } from '../middleware/errorHandler.js'

import { assertCatalogSequence, catalogScopeKey, lockCatalogCopy, saveCatalogReceipt,
  type SupplierCatalogOperation } from './supplierCatalogReceipt.js'

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

const catalogConflict = () => new AppError('SYNC_SUPPLIER_CATALOG_CONFLICT', 'Конфлікт ID або належності прайсу. Імпорт не застосовано; дані не змінено.', 409)

function catalogId(value: unknown): string {
  if (!isUuid(value)) throw new AppError('SYNC_SUPPLIER_CATALOG_INVALID', 'Некоректний ID прайсу', 400)
  return value.toLowerCase()
}

function operationRecordId(payloadId: unknown, aggregateId: unknown): string {
  const id = catalogId(payloadId ?? aggregateId)
  if (id !== catalogId(aggregateId)) throw catalogConflict()
  return id
}

function supplierReference(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !isUuid(value.trim()))
    throw new AppError('SYNC_SUPPLIER_CATALOG_INVALID', 'Некоректний ID постачальника; прайс не змінено', 400)
  return value.trim().toLowerCase()
}

function cleanScope(value: unknown): string | null {
  if (value != null && typeof value !== 'string')
    throw new AppError('SYNC_SUPPLIER_CATALOG_INVALID', 'Некоректне текстове поле прайсу; дані не змінено', 400)
  const clean = String(value ?? '').trim()
  return clean || null
}

function normalizeSku(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().toLocaleUpperCase('uk-UA')
}

function normalizeItem(raw: any, fallbackId: unknown, timestamp: string): CatalogItem {
  const id = catalogId(raw?.id ?? fallbackId)
  const name = String(raw?.name ?? '').trim()
  if (!name) throw new AppError('SYNC_SUPPLIER_CATALOG_INVALID', 'Назва чернової позиції обов’язкова', 400)
  const sku = normalizeSku(raw?.sku)
  if (!sku) throw new AppError('SYNC_SUPPLIER_CATALOG_INVALID', 'Артикул чернової позиції обов’язковий', 400)
  let price: number, quantity: string
  try {
    price = catalogPriceKopecks(raw?.price_kopecks)
    quantity = catalogQuantity(raw?.qty)
  } catch (error) {
    throw new AppError('SYNC_SUPPLIER_CATALOG_INVALID',
      error instanceof Error ? error.message : 'Некоректні числа прайсу', 400)
  }
  return {
    id,
    supplier_id: supplierReference(raw?.supplier_id),
    sku,
    barcode: normalizeExactBarcode(raw?.barcode),
    brand: cleanScope(raw?.brand),
    name,
    price_kopecks: price,
    qty: quantity,
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
    // Share the row lock with the whole catalog transaction: supplier merge/deletion
    // must wait, then observe the committed reference instead of leaving an orphan.
    'SELECT 1 FROM suppliers WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND is_active = true LIMIT 1 FOR SHARE',
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

async function assertImportScope(client: pg.PoolClient, tenantId: string, importId: string,
  supplierId: string | null, warehouseName: string | null, mode: string, items: CatalogItem[]): Promise<void> {
  const header = (await client.query('SELECT tenant_id,supplier_id,mode,warehouse_name FROM supplier_price_imports WHERE id=$1 FOR UPDATE', [importId])).rows[0]
  if (header && (header.tenant_id !== tenantId || header.supplier_id !== supplierId)) throw catalogConflict()
  if (header?.mode != null && (header.mode !== mode || header.warehouse_name !== warehouseName)) throw catalogConflict()
  // Existing IDs from another price list must never be pulled into a replacement.
  const existing = (await client.query(`SELECT tenant_id,supplier_id,warehouse_name FROM supplier_price_items
    WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [items.map(item => item.id)])).rows
  if (existing.some(row => row.tenant_id !== tenantId || row.supplier_id !== supplierId || row.warehouse_name !== warehouseName))
    throw catalogConflict()
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
    const written = await client.query(
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
      WHERE supplier_price_items.tenant_id = EXCLUDED.tenant_id
      RETURNING id`,
      values,
    )
    // ON CONFLICT with a false ownership condition writes zero rows without throwing.
    // Treat that as a conflict so every earlier write in this import rolls back too.
    if (written.rows.length !== batch.length) throw catalogConflict()
  }
}

export async function applySupplierCatalogItemUpsert(
  tenantId: string,
  operation: SupplierCatalogOperation,
): Promise<void> {
  const timestamp = operation.applied_at ?? new Date().toISOString()
  operationRecordId(operation.payload?.id, operation.aggregate_id)
  await runTransaction(async (client) => {
    const receipt=await lockCatalogCopy(client,tenantId,operation,'supplier_catalog.item_upserted')
    if (!receipt) return
    // A confirmed legacy replay is a no-op, not a new numeric write.
    const item = normalizeItem(operation.payload, operation.aggregate_id, timestamp)
    const previous=(await client.query('SELECT tenant_id,supplier_id,warehouse_name FROM supplier_price_items WHERE id=$1 FOR UPDATE',[item.id])).rows[0]
    if (previous && previous.tenant_id!==tenantId) throw catalogConflict()
    const scopes=[catalogScopeKey(item.supplier_id,item.warehouse_name)]
    if (previous) scopes.push(catalogScopeKey(previous.supplier_id,previous.warehouse_name))
    await assertCatalogSequence(client,receipt,scopes,[item.id])
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
    await saveCatalogReceipt(client,receipt,scopes)
  })
}

export async function applySupplierCatalogItemDeleted(
  tenantId: string,
  operation: SupplierCatalogOperation,
): Promise<void> {
  const id = operationRecordId(operation.payload?.id, operation.aggregate_id)
  const timestamp = operation.applied_at ?? new Date().toISOString()
  await runTransaction(async (client) => {
    const receipt=await lockCatalogCopy(client,tenantId,operation,'supplier_catalog.item_deleted')
    if (!receipt) return
    const existing = (await client.query('SELECT tenant_id,supplier_id,warehouse_name FROM supplier_price_items WHERE id=$1 FOR UPDATE', [id])).rows[0]
    if (existing && existing.tenant_id !== tenantId) throw catalogConflict()
    const scopes=existing?[catalogScopeKey(existing.supplier_id,existing.warehouse_name)]:[]
    await assertCatalogSequence(client,receipt,scopes,[id])
    const deleted=await client.query(
      `UPDATE supplier_price_items
       SET deleted_at = COALESCE(deleted_at, $1), updated_at = $1
       WHERE id = $2 AND tenant_id = $3 RETURNING id`,
      [timestamp, id, tenantId],
    )
    if (existing && deleted.rows.length!==1) throw catalogConflict()
    await saveCatalogReceipt(client,receipt,scopes)
  })
}

export async function applySupplierCatalogImported(
  tenantId: string,
  operation: SupplierCatalogOperation,
): Promise<void> {
  const timestamp = operation.applied_at ?? new Date().toISOString()
  const payload = operation.payload ?? {}
  const importRecord = payload.import ?? {}
  const importId = operationRecordId(importRecord.id, operation.aggregate_id)
  if (!Array.isArray(payload.items) || payload.items.length > 50_000) {
    throw new AppError('SYNC_SUPPLIER_CATALOG_INVALID', 'Некоректний або завеликий список позицій імпорту', 400)
  }
  if (payload.mode !== 'replace' && payload.mode !== 'add')
    throw new AppError('SYNC_SUPPLIER_CATALOG_INVALID', 'Некоректний режим імпорту прайсу; дані не змінено', 400)
  const mode = payload.mode
  const supplierId = supplierReference(importRecord.supplier_id)
  const warehouseName = cleanScope(payload.warehouse_name)
  await runTransaction(async (client) => {
    const receipt=await lockCatalogCopy(client,tenantId,operation,'supplier_catalog.imported')
    if (!receipt) return
    const items = payload.items.map((item: any) => normalizeItem({
      ...item, supplier_id: supplierId, warehouse_name: warehouseName,
    }, item?.id, timestamp))
    if (new Set(items.map((item: CatalogItem) => item.id)).size !== items.length) throw catalogConflict()
    const scopes=[catalogScopeKey(supplierId,warehouseName)]
    await assertCatalogSequence(client,receipt,scopes,items.map((item:CatalogItem)=>item.id))
    await assertSupplier(client, tenantId, supplierId)
    await assertImportScope(client, tenantId, importId, supplierId, warehouseName, mode, items)
    const previousScope=await loadScope(client,tenantId,supplierId,warehouseName)
    if (mode === 'replace') {
      const removed=await client.query(
        `UPDATE supplier_price_items
         SET deleted_at = COALESCE(deleted_at, $1), updated_at = $1
         WHERE tenant_id = $2
           AND supplier_id IS NOT DISTINCT FROM $3::uuid
           AND warehouse_name IS NOT DISTINCT FROM $4::text
           AND deleted_at IS NULL RETURNING id`,
        [timestamp, tenantId, supplierId, warehouseName],
      )
      if (removed.rows.length!==previousScope.length) throw catalogConflict()
    }

    const scope = mode === 'add' ? previousScope : []
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

    const writtenImport = await client.query(
      `INSERT INTO supplier_price_imports (
        id, tenant_id, supplier_id, filename, status, total_rows, processed_rows,
        errors_log, created_at, updated_at, mode, warehouse_name
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
      ON CONFLICT (id) DO UPDATE SET
        supplier_id = EXCLUDED.supplier_id,
        filename = EXCLUDED.filename,
        status = EXCLUDED.status,
        total_rows = EXCLUDED.total_rows,
        processed_rows = EXCLUDED.processed_rows,
        errors_log = EXCLUDED.errors_log,
        mode = EXCLUDED.mode,
        warehouse_name = EXCLUDED.warehouse_name,
        updated_at = EXCLUDED.updated_at
      WHERE supplier_price_imports.tenant_id = EXCLUDED.tenant_id
      RETURNING id`,
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
        mode,
        warehouseName,
      ],
    )
    if (writtenImport.rows.length !== 1) throw catalogConflict()
    await saveCatalogReceipt(client,receipt,scopes)
  })
}
