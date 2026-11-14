import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { AppError } from '../middleware/errorHandler.js'
import { MVP_TENANT_ID } from '../config/constants.js'
import type { SyncOutboxOperation } from './sync/syncCore.js'

export type SupplierCatalogOperation = Pick<SyncOutboxOperation,
  'tenant_id' | 'operation_id' | 'aggregate_id' | 'device_id' | 'sequence' |
  'operation_type' | 'payload' | 'created_at' | 'applied_at'>
type CatalogOperationType = 'supplier_catalog.item_upserted' | 'supplier_catalog.item_deleted' | 'supplier_catalog.imported'
type Receipt = {
  tenantId: string
  operationId: string
  aggregateId: string
  operationType: CatalogOperationType
  deviceId: string
  sequence: number
  payloadHash: string
}

const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

function conflict(): never {
  throw new AppError(
    'SYNC_SUPPLIER_CATALOG_CONFLICT',
    'Повтор або порядок передачі прайсу не збігається з підтвердженою історією. Прайс не перезаписано; потрібна звірка.',
    409,
  )
}

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .filter(key => value[key] !== undefined)
      .map(key => [key, canonical(value[key])]))
  }
  return value
}

export const catalogScopeKey = (supplierId: string | null, warehouse: string | null) =>
  JSON.stringify([supplierId, warehouse])

/** Checked inside the caller's transaction, before any catalog/invoice mutation.
 * Do not cache: rollout/recovery may change the schema between requests. The
 * empty SELECT also holds a relation read lock until this transaction ends. */
export async function assertCatalogOwnershipSchema(client: PoolClient): Promise<void> {
  try {
    await client.query(`SELECT ownership_changed,previous_supplier_id,next_supplier_id
      FROM supplier_catalog_copy_receipts LIMIT 0`)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code !== '42703' && code !== '42P01') throw error
    throw new AppError('SYNC_SCHEMA_UPGRADE_REQUIRED',
      'Сервер ще не готовий до цієї версії прайсів. Дані не змінено; спочатку завершіть оновлення серверної бази.', 503)
  }
}

/** Null means this exact operation already committed. Never rewrite newer state
 * when acknowledging an old retry, even after the original supplier was merged. */
export async function lockCatalogCopy(
  client: PoolClient,
  tenantId: string,
  operation: SupplierCatalogOperation,
  expectedType: CatalogOperationType,
): Promise<Receipt | null> {
  if ((tenantId !== MVP_TENANT_ID && !uuid(tenantId)) || operation.tenant_id !== tenantId || !uuid(operation.operation_id)
    || !uuid(operation.aggregate_id) || operation.operation_type !== expectedType
    || typeof operation.device_id !== 'string' || !operation.device_id.trim()
    || !Number.isSafeInteger(operation.sequence) || operation.sequence <= 0) {
    throw new AppError('SYNC_SUPPLIER_CATALOG_INVALID', 'Некоректні реквізити передачі прайсу; дані не змінено.', 400)
  }
  // applied_at and operation.created_at are assigned afresh by the server on retry.
  // The original source time, if present, is already retained inside payload.
  const receipt: Receipt = {
    tenantId,
    operationId: operation.operation_id.toLowerCase(),
    aggregateId: operation.aggregate_id.toLowerCase(),
    operationType: expectedType,
    deviceId: operation.device_id,
    sequence: operation.sequence,
    payloadHash: createHash('sha256').update(JSON.stringify(canonical(operation.payload ?? {}))).digest('hex'),
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`supplier-catalog:${tenantId}`])
  await assertCatalogOwnershipSchema(client)
  const previous = (await client.query(
    'SELECT * FROM supplier_catalog_copy_receipts WHERE tenant_id=$1 AND operation_id=$2',
    [tenantId, receipt.operationId],
  )).rows[0]
  if (!previous) return receipt
  if (previous.aggregate_id !== receipt.aggregateId || previous.operation_type !== receipt.operationType
    || previous.device_id !== receipt.deviceId || Number(previous.source_sequence) !== receipt.sequence
    || previous.payload_hash !== receipt.payloadHash) conflict()
  return null
}

/** Block unseen old copies only for the affected list/records. An unrelated
 * supplier may legitimately finish later after an earlier dependency failure. */
export async function assertCatalogSequence(
  client: PoolClient,
  receipt: Receipt,
  scopes: string[],
  recordIds: string[],
): Promise<void> {
  const newer = await client.query(
    `SELECT operation_id FROM supplier_catalog_copy_receipts
     WHERE tenant_id=$1 AND device_id=$2 AND source_sequence >= $3
       AND (source_sequence=$3 OR scope_keys && $4::text[] OR aggregate_id=ANY($5::uuid[]))
     LIMIT 1`,
    [receipt.tenantId, receipt.deviceId, receipt.sequence, scopes, [receipt.aggregateId, ...recordIds]],
  )
  if (newer.rows.length) conflict()
  await assertNoNewerCatalogMerge(client, receipt.tenantId, receipt.deviceId, receipt.sequence, scopes,
    [receipt.aggregateId, ...recordIds])
}

/** Supplier transfers are ordering barriers too. Otherwise a delayed replacement
 * addressed to the surviving supplier could erase the newly transferred list. */
export async function assertNoNewerCatalogMerge(client: PoolClient, tenant: string, device: string,
  sequence: number, scopes: string[], recordIds: string[]): Promise<void> {
  const newer = await client.query(`
    SELECT 1 FROM supplier_merge_receipts m
    WHERE m.tenant_id=$1 AND (m.device_id<>$2 OR m.source_sequence >= $3)
      AND m.history_payload ? 'catalog'
      AND ((m.device_id=$2 AND m.source_sequence=$3) OR EXISTS (
        SELECT 1 FROM (
          SELECT value FROM jsonb_array_elements(m.history_payload->'catalog'->'items')
          UNION ALL SELECT value FROM jsonb_array_elements(m.history_payload->'catalog'->'imports')
        ) moved
        WHERE (moved.value->>'id')::uuid=ANY($5::uuid[]) OR EXISTS (
          SELECT 1 FROM unnest($4::text[]) scope
          WHERE scope::jsonb=jsonb_build_array(m.primary_id::text,moved.value->'warehouse_name')
             OR scope::jsonb=jsonb_build_array(m.duplicate_id::text,moved.value->'warehouse_name')
        )
      )) LIMIT 1`, [tenant,device,sequence,scopes,recordIds])
  if (newer.rows.length) conflict()
}

export type CatalogOwnershipChange = { from: string | null; to: string | null }

export async function saveCatalogReceipt(client: PoolClient, receipt: Receipt, scopes: string[],
  ownership?: CatalogOwnershipChange): Promise<void> {
  if (ownership && (receipt.operationType !== 'supplier_catalog.item_upserted'
    || ownership.from === ownership.to
    || ownership.from !== null && !uuid(ownership.from)
    || ownership.to !== null && !uuid(ownership.to))) conflict()
  const expected = {
    tenant_id: receipt.tenantId, operation_id: receipt.operationId, aggregate_id: receipt.aggregateId,
    operation_type: receipt.operationType, device_id: receipt.deviceId, source_sequence: receipt.sequence,
    payload_hash: receipt.payloadHash, scope_keys: [...new Set(scopes)],
    ownership_changed: Boolean(ownership), previous_supplier_id: ownership?.from ?? null,
    next_supplier_id: ownership?.to ?? null,
  }
  const inserted = await client.query(
    `INSERT INTO supplier_catalog_copy_receipts
      (tenant_id,operation_id,aggregate_id,operation_type,device_id,source_sequence,payload_hash,scope_keys,
       ownership_changed,previous_supplier_id,next_supplier_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11) RETURNING operation_id`,
    Object.values(expected),
  )
  if (inserted.rows.length !== 1) conflict()
  // Read after all receipt triggers too: a skipped or altered proof must roll back
  // the business mutation, not make a later retry trust incomplete evidence.
  const stored = (await client.query(
    'SELECT * FROM supplier_catalog_copy_receipts WHERE tenant_id=$1 AND operation_id=$2',
    [receipt.tenantId,receipt.operationId],
  )).rows[0]
  if (!stored || !isDeepStrictEqual(
    Object.fromEntries(Object.keys(expected).map(key => [key,key === 'source_sequence' ? Number(stored[key]) : stored[key]])),
    expected,
  )) conflict()
}
