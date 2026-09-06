const { DatabaseSync } = require('node:sqlite')
const path = require('node:path')

// Never use LocalDatabase here: its constructor migrates and repairs data.
const databasePath = process.argv[2]
if (!databasePath || !path.isAbsolute(databasePath)) throw new Error('Pass the absolute database path')
const db = new DatabaseSync(databasePath, { readOnly: true, timeout: 2000 })
try {
  db.exec('PRAGMA query_only = ON; BEGIN')
  const checks = {
    integrity: 'PRAGMA quick_check',
    foreignKeys: 'SELECT COUNT(*) AS errors FROM pragma_foreign_key_check',
    schema: 'SELECT MAX(version) AS version FROM schema_migrations',
    products: `SELECT COUNT(*) AS active, SUM(qty_on_hand > 0) AS stocked, SUM(qty_on_hand < 0) AS negative
      FROM products WHERE deleted_at IS NULL AND is_active = 1`,
    queue: `SELECT status, operation_type, COUNT(*) AS count, MIN(created_at) AS oldest,
      MAX(attempts) AS max_attempts, last_error FROM sync_outbox
      WHERE status IN ('pending','failed') GROUP BY status, operation_type, last_error`,
    salesTotals: `SELECT COUNT(*) AS inconsistent FROM sales
      WHERE deleted_at IS NULL AND status = 'completed'
        AND total != cash_amount + card_amount + transfer_amount + debt_amount`,
    duplicateSales: `SELECT COUNT(*) AS duplicate_groups FROM (
      SELECT tenant_id, client_operation_id FROM sales
      WHERE client_operation_id IS NOT NULL GROUP BY tenant_id, client_operation_id HAVING COUNT(*) > 1)`,
    negativeProducts: `SELECT sku, barcode, name, qty_on_hand FROM products
      WHERE deleted_at IS NULL AND is_active=1 AND qty_on_hand < 0`,
    movementMismatch: `SELECT COUNT(*) AS count FROM products p
      WHERE p.deleted_at IS NULL AND p.is_active=1 AND ABS(p.qty_on_hand - (
        SELECT m.qty_after FROM inventory_movements m WHERE m.product_id = p.id
          AND m.tenant_id=p.tenant_id AND m.deleted_at IS NULL ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1
      )) > 0.00001`,
    negativeEnabled: `SELECT json_extract(value_json, '$.allow_negative_qty') AS allow_negative_qty
      FROM app_meta WHERE key='shop_settings'`,
  }
  for (const [check, sql] of Object.entries(checks)) console.log(JSON.stringify({ check, rows: db.prepare(sql).all() }))
} finally {
  db.exec('ROLLBACK')
  db.close()
}
