import type { LocalDatabase } from '../db/localDatabase'

export const SERVER_RESET_GENERATION_KEY = 'desktop_server_reset_generation'

export function readServerResetGeneration(db: LocalDatabase): number {
  const row = db.prepare(`
    SELECT value_json FROM app_meta WHERE key = ?
  `).get(SERVER_RESET_GENERATION_KEY) as { value_json: string } | undefined
  if (!row) return 0
  try {
    const value = Number(JSON.parse(row.value_json))
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

export function writeServerResetGeneration(
  db: LocalDatabase,
  generation: number,
  timestamp: string,
): void {
  const normalized = Number.isSafeInteger(generation) && generation >= 0 ? generation : 0
  db.prepare(`
    INSERT INTO app_meta(key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(SERVER_RESET_GENERATION_KEY, JSON.stringify(normalized), timestamp)
}

/**
 * Clears only the selected tenant after the server has performed a full reset.
 * Device identity, schema metadata and user-owned print settings stay intact.
 */
export function resetLocalTenantData(
  db: LocalDatabase,
  tenantId: string,
  generation: number,
  timestamp: string,
): void {
  db.transaction(() => {
    // Break the only server-data cycle before child-first deletion.
    db.prepare(`
      UPDATE customer_orders
      SET sale_id = NULL, exchange_source_order_id = NULL
      WHERE tenant_id = ?
    `).run(tenantId)

    const tablesInDeleteOrder = [
      'inventory_count_entries',
      'inventory_items',
      'inventory_sessions',
      'customer_return_items',
      'customer_returns',
      'writeoff_items',
      'writeoffs',
      'salary_payments',
      'order_payments',
      'customer_order_items',
      'stock_reserves',
      'warehouse_movements',
      'supplier_payments',
      'supply_invoice_items',
      'supply_invoices',
      'supplier_price_items',
      'supplier_price_imports',
      'customer_deposit_transactions',
      'bonus_transactions',
      'sale_payments',
      'sale_items',
      'cash_operations',
      'inventory_movements',
      'fiscal_sale_intents',
      'sales',
      'shifts',
      'customer_vehicles',
      'customer_orders',
      'customers',
      'product_barcodes',
      'product_aliases',
      'product_cross_numbers',
      'commission_rules',
      'products',
      'categories',
      'brands',
      'suppliers',
      'staff_users',
      'audit_log',
      'sync_outbox',
    ] as const

    for (const table of tablesInDeleteOrder) {
      db.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).run(tenantId)
    }
    db.prepare('DELETE FROM local_sequences WHERE scope LIKE ?').run(`${tenantId}:%`)
    db.prepare(`
      UPDATE sync_state
      SET pull_cursor = NULL,
          last_attempt_at = ?,
          last_success_at = NULL,
          last_error = NULL,
          updated_at = ?
      WHERE scope = 'desktop_server_pull'
    `).run(timestamp, timestamp)
    writeServerResetGeneration(db, generation, timestamp)
  })
}
