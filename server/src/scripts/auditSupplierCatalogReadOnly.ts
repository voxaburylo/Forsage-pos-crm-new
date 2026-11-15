import 'dotenv/config'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { assertSupplierCatalogAuditConnection, compareSupplierCatalog } from '../lib/supplierCatalogCompatibility.js'

// Only explicit paths and project identity; never instantiate LocalDatabase,
// which performs migrations/repairs when opened.
const [localPath, tenant, expectedProject] = process.argv.slice(2)
if (!localPath || !path.isAbsolute(localPath) || !/^[a-f0-9-]{36}$/i.test(tenant ?? '')
  || !/^[a-z]{20}$/.test(expectedProject ?? '') || !process.env.DATABASE_URL)
  throw new Error('Pass absolute local database path, tenant ID and expected Supabase project ref; set DATABASE_URL')
assertSupplierCatalogAuditConnection(process.env.DATABASE_URL, expectedProject)
const local = new DatabaseSync(localPath, { readOnly: true, timeout: 2000 })
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 })
let localTransaction = false, remoteTransaction = false
try {
  local.exec('PRAGMA query_only=ON; BEGIN')
  localTransaction = true
  await client.connect()
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  remoteTransaction = true
  await client.query("SET LOCAL statement_timeout='15s'")
  const startedAt = new Date().toISOString()
  const reports = []
  for (const table of ['supplier_price_items','supplier_price_imports'] as const) {
    const localRows = local.prepare('SELECT * FROM ' + table + ' WHERE tenant_id=? ORDER BY id LIMIT 100001').all(tenant)
    // Ask for text timestamps explicitly; pg's default Date parser loses microseconds.
    const remoteRows = (await client.query('SELECT *,'
      + " to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at,"
      + (table === 'supplier_price_items'
        ? " to_char(deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS deleted_at"
        : ' NULL::text AS deleted_at')
      + ' FROM ' + table + ' WHERE tenant_id=$1 ORDER BY id LIMIT 100001', [tenant])).rows
    reports.push(compareSupplierCatalog(table, tenant, localRows, remoteRows))
  }
  const proofColumns = (await client.query("SELECT column_name FROM information_schema.columns"
    + " WHERE table_schema='public' AND table_name='supplier_catalog_copy_receipts'"
    + " AND column_name IN ('ownership_changed','previous_supplier_id','next_supplier_id')")).rows
  const evidence = (await client.query('SELECT'
    + ' (SELECT count(*) FROM supplier_catalog_copy_receipts WHERE tenant_id=$1) AS catalog_receipts,'
    + ' (SELECT count(*) FROM supplier_merge_receipts WHERE tenant_id=$1) AS merge_receipts', [tenant])).rows[0]
  const localQueue = local.prepare("SELECT operation_type,status,count(*) AS count FROM sync_outbox"
    + " WHERE tenant_id=? AND (operation_type LIKE 'supplier_catalog.%' OR operation_type='supplier.merged')"
    + ' GROUP BY operation_type,status ORDER BY operation_type,status').all(tenant)
  console.log(JSON.stringify({ readOnly: true, startedAt, completedAt: new Date().toISOString(),
    crossDatabaseAtomicSnapshot: false, reports, localQueue, evidence,
    ownershipProofSchemaPresent: proofColumns.length === 3,
    automaticRepairAllowed: false, stockAndInvoicesAudited: false }, null, 2))
} catch (error) {
  // Database errors may contain connection details; emit only a stable error code.
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'AUDIT_FAILED'
  console.error(JSON.stringify({ readOnly: true, completed: false, code }))
  process.exitCode = 1
} finally {
  if (remoteTransaction) await client.query('ROLLBACK').catch(() => undefined)
  await client.end()
  if (localTransaction) local.exec('ROLLBACK')
  local.close()
}
