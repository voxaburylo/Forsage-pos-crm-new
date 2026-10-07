import { runTransaction } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { isUuid } from './sync/syncCore.js'
import type { PoolClient } from 'pg'

const conflict = () => new AppError('SUPPLIER_MERGE_CONFLICT', 'Злиття вже має інший результат або стан картки змінився. Потрібна звірка.', 409)
const quote = (value: string) => '"' + value.replace(/"/g, '""') + '"'

/** Unknown/foreign/deleted references fail closed. Only explicit callers may move known tables. */
export async function assertNoSupplierReferences(client: PoolClient, source: string, allowed: string[] = []) {
  const references = (await client.query(`
    SELECT c.table_name,c.column_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
    WHERE c.table_schema='public' AND c.column_name='supplier_id' AND t.table_type='BASE TABLE'
    UNION
    SELECT r.relname,a.attname FROM pg_constraint f
    JOIN pg_class r ON r.oid=f.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=ANY(f.conkey)
    WHERE f.contype='f' AND f.confrelid='public.suppliers'::regclass AND n.nspname='public'
      AND a.attname<>'tenant_id'`)).rows
  for (const ref of references) {
    if (ref.table_name === 'supplier_merge_receipts'
      || (allowed.includes(ref.table_name) && ref.column_name === 'supplier_id')) continue
    if ((await client.query('SELECT 1 FROM public.' + quote(ref.table_name) + ' WHERE ' + quote(ref.column_name) + '=$1 LIMIT 1', [source])).rowCount)
      throw new AppError('SUPPLIER_MERGE_HISTORY', 'До дубліката прив’язані документи або прайси. Злиття з цією історією потребує окремої звірки; нічого не змінено.', 409)
  }
}

export async function assertSupplierNotMerged(client: PoolClient, tenant: string, id: string) {
  if ((await client.query('SELECT 1 FROM supplier_merge_receipts WHERE tenant_id=$1 AND duplicate_id=$2', [tenant, id])).rowCount)
    throw new AppError('SUPPLIER_MERGED', 'Постачальника вже об’єднано. Оновіть список і виберіть основну картку.', 409)
}

/** This path handles unused duplicates only. Moving historical documents needs
 * an explicit copied merge transition; never invalidate their receipt hashes. */
export async function mergeEmptySupplier(primaryId: string, duplicateId: string, tenant: string, timestamp = new Date().toISOString()) {
  if (!isUuid(primaryId) || !isUuid(duplicateId) || !isUuid(tenant) || primaryId.toLowerCase() === duplicateId.toLowerCase()
    || !Number.isFinite(Date.parse(timestamp))) throw new AppError('SUPPLIER_MERGE_INVALID', 'Некоректна пара постачальників', 422)
  const primary = primaryId.toLowerCase(), duplicate = duplicateId.toLowerCase()
  return runTransaction(async client => {
    // Same lock order for A→B and B→A, including the check and receipt commit.
    const suppliers = (await client.query('SELECT * FROM suppliers WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE', [tenant, [primary, duplicate]])).rows
    const target = suppliers.find(row => row.id === primary), source = suppliers.find(row => row.id === duplicate)
    if (!target || !source) throw new AppError('NOT_FOUND', 'Постачальника не знайдено', 404)
    const receipt = (await client.query('SELECT * FROM supplier_merge_receipts WHERE tenant_id=$1 AND duplicate_id=$2', [tenant, duplicate])).rows[0]
    if (receipt) {
      if (receipt.primary_id !== primary || !source.deleted_at || source.is_active !== false
        || receipt.result?.id !== primary) throw conflict()
    } else if (source.deleted_at || target.deleted_at || target.is_active !== true) throw conflict()
    await assertNoSupplierReferences(client, duplicate)
    if (receipt) return receipt.result
    await client.query('UPDATE suppliers SET deleted_at=$3,is_active=false,updated_at=$3 WHERE tenant_id=$1 AND id=$2', [tenant, duplicate, timestamp])
    await client.query('INSERT INTO supplier_merge_receipts(tenant_id,duplicate_id,primary_id,result,merged_at) VALUES($1,$2,$3,$4::jsonb,$5)',
      [tenant, duplicate, primary, JSON.stringify(target), timestamp])
    return target
  })
}
