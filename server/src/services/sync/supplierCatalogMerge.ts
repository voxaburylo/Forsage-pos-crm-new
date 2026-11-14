import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { catalogQuantity } from '../../lib/supplierCatalogNumbers.js'
import { assertCatalogOwnershipSchema, assertNoNewerCatalogMerge } from '../supplierCatalogReceipt.js'
import { validateSupplierCatalogIdentityRows } from '../supplierCatalogSyncService.js'
import { AppError } from '../../middleware/errorHandler.js'
import { invoiceDate, invoiceId, invoiceMoney, invoiceInvalid } from './supplierInvoiceState.js'

const catalogMergeConflict = (): never => { throw new AppError('SYNC_SUPPLIER_CATALOG_CONFLICT',
  'Прайси або історія постачальника не збігаються з підтвердженим перенесенням. Нічого не змінено; потрібна звірка.',409) }
const nullableText = z.string().nullable()
const item = z.object({
  id: invoiceId, sku: z.string().min(1), barcode: nullableText, brand: nullableText,
  name: z.string().min(1), price_kopecks: invoiceMoney,
  qty: z.string().refine(value => { try { return catalogQuantity(value) === value } catch { return false } }),
  warehouse_name: nullableText, created_at: invoiceDate, deleted_at: invoiceDate.nullable(),
}).strict()
const imported = z.object({
  id: invoiceId, filename: z.string().min(1), mode: z.enum(['add','replace']).nullable(),
  warehouse_name: nullableText, status: z.enum(['pending','processing','completed','failed']),
  total_rows: z.number().int().nonnegative().max(2147483647),
  processed_rows: z.number().int().nonnegative().max(2147483647),
  errors_log: z.array(z.object({ row: z.number().int().nonnegative(), error: z.string(), raw: z.string().optional() }).strict()),
  created_at: invoiceDate, deleted_at: invoiceDate.nullable(),
}).strict()
export const supplierCatalogMergeSchema = z.object({
  version: z.literal(1),
  items: z.array(item).max(5000),
  imports: z.array(imported).max(1000),
}).strict().superRefine((copy, ctx) => {
  if (!copy.items.length && !copy.imports.length
    || new Set(copy.items.map(row => row.id)).size !== copy.items.length
    || new Set(copy.imports.map(row => row.id)).size !== copy.imports.length
    || copy.imports.some(row => row.processed_rows > row.total_rows
      || row.status === 'pending' || row.status === 'processing')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Incomplete supplier catalog manifest' })
  }
})
type Catalog = z.infer<typeof supplierCatalogMergeSchema>
const tables = ['supplier_price_items','supplier_price_imports'] as const
const iso = (value: any) => value == null ? null : new Date(value).toISOString()
function view(table: typeof tables[number], row: any): any {
  const common = { id: row.id, warehouse_name: row.warehouse_name ?? null,
    created_at: iso(row.created_at), deleted_at: iso(row.deleted_at) }
  return table === 'supplier_price_items'
    ? { ...common, sku: row.sku, barcode: row.barcode, brand: row.brand, name: row.name,
      price_kopecks: row.price_kopecks, qty: catalogQuantity(row.qty) }
    : { ...common, filename: row.filename, mode: row.mode ?? null, status: row.status,
      total_rows: row.total_rows, processed_rows: row.processed_rows, errors_log: row.errors_log }
}
const sorted = (rows: any[]) => [...rows].sort((a,b) => a.id.localeCompare(b.id))
export const supplierCatalogMergeScopes = (copy: Catalog, source: string, target: string): string[] =>
  [...new Set([...copy.items, ...copy.imports].flatMap(row =>
    [JSON.stringify([source,row.warehouse_name]), JSON.stringify([target,row.warehouse_name])]))]

/** The same lock as every catalog writer, always BEFORE supplier/item row locks. */
export async function lockSupplierCatalogMerge(client: PoolClient, tenant: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['supplier-catalog:' + tenant])
  await assertCatalogOwnershipSchema(client)
}

/** Called before any changes, inside the enclosing invoice+supplier transaction.
 * All source rows, including deleted ones, must already be mirrored exactly.
 * Price collisions are rejected, never summed or silently overwritten. */
export async function prepareSupplierCatalogMerge(client: PoolClient, tenant: string,
  source: string, target: string, copy: Catalog, device: string, sequence: number) {
  const scopes = supplierCatalogMergeScopes(copy,source,target)
  const newer = await client.query(
    `SELECT 1 FROM supplier_catalog_copy_receipts
     WHERE tenant_id=$1 AND device_id=$2 AND source_sequence >= $3
       AND (source_sequence=$3 OR scope_keys && $4::text[]) LIMIT 1`,
    [tenant,device,sequence,scopes])
  if (newer.rows.length) catalogMergeConflict()
  await assertNoNewerCatalogMerge(client,tenant,device,sequence,scopes,[...copy.items,...copy.imports].map(row => row.id))
  const captures: { table: typeof tables[number]; rows: any[]; target: any[] }[] = []
  for (const table of tables) {
    const rows = (await client.query('SELECT * FROM ' + table + ' WHERE supplier_id=$1 ORDER BY id LIMIT 10001 FOR UPDATE',[source])).rows
    const destination = (await client.query('SELECT * FROM ' + table + ' WHERE supplier_id=$1 ORDER BY id LIMIT 10001 FOR UPDATE',[target])).rows
    if (rows.length > 10000 || destination.length > 10000) invoiceInvalid()
    const expected = sorted(table === 'supplier_price_items' ? copy.items : copy.imports)
    if (rows.some(row => row.tenant_id !== tenant) || destination.some(row => row.tenant_id !== tenant)) catalogMergeConflict()
    const snapshots = (() => {
      try { return sorted(rows.map(row => view(table,row))) } catch { return catalogMergeConflict() }
    })()
    if (!isDeepStrictEqual(snapshots, expected)) catalogMergeConflict()
    captures.push({table,rows,target:destination})
  }
  const active = [...captures[0].rows,...captures[0].target].filter(row => !row.deleted_at)
  // A bounded merge is preferable to holding a shop lock during an unbounded scan.
  if (active.length > 10000) invoiceInvalid()
  const warehouses = new Map<string|null, any[]>()
  for (const row of active) {
    const key = row.warehouse_name ?? null
    const scope = warehouses.get(key) ?? []
    scope.push(row); warehouses.set(key,scope)
  }
  for (const rows of warehouses.values()) validateSupplierCatalogIdentityRows(rows)

  return async (timestamp: string) => {
    for (const capture of captures) {
      const written = (await client.query('UPDATE ' + capture.table +
        ' SET supplier_id=$3,updated_at=$4 WHERE tenant_id=$1 AND supplier_id=$2 RETURNING id,updated_at',
        [tenant,source,target,timestamp])).rows
      if (written.length !== capture.rows.length) catalogMergeConflict()
      const byId = new Map(written.map(row => [row.id,row]))
      capture.rows = capture.rows.map(row => {
        const stored = byId.get(row.id)
        if (!(stored?.updated_at instanceof Date) || !Number.isFinite(stored.updated_at.getTime())) catalogMergeConflict()
        return { ...row, supplier_id: target, updated_at: stored.updated_at }
      })
    }
    // Called again after receipts and invoice writes: late trigger damage must roll back.
    return async () => {
      for (const capture of captures) {
        if ((await client.query('SELECT 1 FROM ' + capture.table + ' WHERE supplier_id=$1 LIMIT 1',[source])).rows.length) catalogMergeConflict()
        const actual = (await client.query('SELECT * FROM ' + capture.table + ' WHERE supplier_id=$1 ORDER BY id',[target])).rows
        if (!isDeepStrictEqual(actual, sorted([...capture.target,...capture.rows]))) catalogMergeConflict()
      }
    }
  }
}

/** A retry follows exact IDs through durable, ordered ownership evidence.
 * Price/name edits are not ownership evidence. Historical receipts are never rewritten. */
export async function verifySupplierCatalogMergeRetry(client: PoolClient, tenant: string, target: string,
  copy: Catalog, origin: { device_id: string; sequence: number }): Promise<void> {
  const changes = copy.items.length ? (await client.query(
    `SELECT aggregate_id,operation_type,source_sequence,previous_supplier_id,next_supplier_id
     FROM supplier_catalog_copy_receipts
     WHERE tenant_id=$1 AND device_id=$2 AND aggregate_id=ANY($3::uuid[])
       AND source_sequence>$4 AND ownership_changed
     ORDER BY source_sequence LIMIT 10001`,
    [tenant,origin.device_id,copy.items.map(row => row.id),origin.sequence],
  )).rows : []
  if (changes.length > 10000) catalogMergeConflict()
  const byItem = new Map<string, typeof changes>()
  for (const change of changes) {
    if (change.operation_type !== 'supplier_catalog.item_upserted'
      || !Number.isSafeInteger(Number(change.source_sequence))
      || change.previous_supplier_id === change.next_supplier_id) catalogMergeConflict()
    const list = byItem.get(change.aggregate_id) ?? []
    list.push(change); byItem.set(change.aggregate_id,list)
  }
  const bySupplier = new Map<string, { supplier: any; receipt: any; items?: Set<string>; imports?: Set<string> }>()
  const supplierEvidence = async (id: string) => {
    if (!bySupplier.has(id)) {
      const supplier = (await client.query('SELECT deleted_at,is_active FROM suppliers WHERE tenant_id=$1 AND id=$2',[tenant,id])).rows[0]
      const receipt = (await client.query('SELECT primary_id,device_id,source_sequence,history_payload FROM supplier_merge_receipts WHERE tenant_id=$1 AND duplicate_id=$2',[tenant,id])).rows[0]
      const evidence: {supplier: any; receipt: any; items?: Set<string>; imports?: Set<string>} = {supplier,receipt}
      if (!supplier) catalogMergeConflict()
      if (receipt?.history_payload?.catalog) {
        const parsed = supplierCatalogMergeSchema.safeParse(receipt.history_payload.catalog)
        if (!supplier.deleted_at || supplier.is_active !== false || !parsed.success
          || receipt.history_payload.duplicate_supplier_id !== id
          || receipt.history_payload.primary_supplier_id !== receipt.primary_id) return catalogMergeConflict()
        evidence.items = new Set(parsed.data.items.map(row => row.id))
        evidence.imports = new Set(parsed.data.imports.map(row => row.id))
      }
      bySupplier.set(id,evidence)
    }
    return bySupplier.get(id)!
  }
  for (const table of tables) {
    const original = table === 'supplier_price_items' ? copy.items : copy.imports
    if (!original.length) continue
    const rows = (await client.query('SELECT id,tenant_id,supplier_id FROM ' + table +
      ' WHERE id=ANY($1::uuid[])',[original.map(row => row.id)])).rows
    if (rows.length !== original.length || rows.some(row => row.tenant_id !== tenant)) catalogMergeConflict()
    for (const row of rows) {
      let current: string | null = target
      let cursor = origin.sequence, manualIndex = 0, mergeCount = 0
      const manual = table === 'supplier_price_items' ? byItem.get(row.id) ?? [] : []
      while (true) {
        const evidence = current === null ? null : await supplierEvidence(current)
        const receipt = evidence?.receipt
        const participates = (table === 'supplier_price_items' ? evidence?.items : evidence?.imports)?.has(row.id)
        const nextMerge = participates ? Number(receipt.source_sequence) : null
        if (nextMerge !== null && (!Number.isSafeInteger(nextMerge) || nextMerge <= cursor
          || receipt.device_id !== origin.device_id)) catalogMergeConflict()
        const change = manual[manualIndex]
        const nextManual = change ? Number(change.source_sequence) : null
        if (nextManual !== null && (nextManual <= cursor || nextManual === nextMerge)) catalogMergeConflict()
        if (change && (nextMerge === null || nextManual! < nextMerge)) {
          if (change.previous_supplier_id !== current) catalogMergeConflict()
          current = change.next_supplier_id
          cursor = nextManual!
          manualIndex++
          continue
        }
        if (nextMerge !== null) {
          if (++mergeCount > 100) catalogMergeConflict()
          current = receipt.primary_id
          cursor = nextMerge
          continue
        }
        // A deleted/merged supplier cannot still own this row. An earlier explicit
        // move away is fine, including a later empty merge of the old supplier.
        if (current !== row.supplier_id || evidence?.supplier.deleted_at || evidence?.receipt) catalogMergeConflict()
        break
      }
    }
  }
}
