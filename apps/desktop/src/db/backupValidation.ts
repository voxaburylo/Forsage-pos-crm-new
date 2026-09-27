import type { DatabaseSync } from 'node:sqlite'

/** Self-contained: also executed in the isolated backup worker. Never repairs data. */
export function assertBackupContents(probe: DatabaseSync): void {
  const checks = probe.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>
  if (checks.length !== 1 || checks[0]?.quick_check !== 'ok') throw new Error('LOCAL_BACKUP_CORRUPT')
  for (const table of ['schema_migrations', 'app_meta', 'products', 'customers', 'staff_users', 'sales', 'sale_items',
    'sale_payments', 'shifts', 'cash_operations', 'inventory_movements', 'inventory_sessions', 'inventory_items',
    'supply_invoices', 'supply_invoice_items', 'supplier_payments', 'customer_orders', 'customer_order_items',
    'order_payments', 'sync_outbox']) {
    if (!probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      throw new Error('LOCAL_BACKUP_MISSING_TABLE: ' + table)
  }
  const identity = probe.prepare("SELECT value_json FROM app_meta WHERE key='device_id'").get() as { value_json: string } | undefined
  let deviceId: unknown
  try { deviceId = identity ? JSON.parse(identity.value_json) : null } catch { deviceId = null }
  if (typeof deviceId !== 'string' || !deviceId.trim()) throw new Error('LOCAL_BACKUP_NOT_FORSAGE_DATABASE')
  const version = probe.prepare('SELECT max(version) AS version FROM schema_migrations').get() as { version: number | null }
  if (!Number.isSafeInteger(version.version) || Number(version.version) < 1) throw new Error('LOCAL_BACKUP_INVALID_SCHEMA')
  // quick_check verifies pages, not references between business documents.
  if (probe.prepare('PRAGMA foreign_key_check').get()) throw new Error('LOCAL_BACKUP_BROKEN_REFERENCES')
}
