// Diagnostic only. No inventory corrections, migrations, server requests or business writes.
const { DatabaseSync } = require('node:sqlite')
const { writeFileSync } = require('node:fs')
const path = require('node:path')
const [databasePath, reportPath] = process.argv.slice(2)
if (!databasePath || !path.isAbsolute(databasePath)) throw Error('Pass an absolute SQLite database path')
if (reportPath && (!path.isAbsolute(reportPath) || path.extname(reportPath).toLowerCase() !== '.json')) throw Error('Report must be an absolute .json path')
const db = new DatabaseSync(databasePath, { readOnly: true, timeout: 2000 })
try {
  db.exec('PRAGMA query_only=ON; BEGIN')
  const mismatches = db.prepare(`
    WITH latest AS (
      SELECT *, ROW_NUMBER() OVER(PARTITION BY tenant_id,product_id ORDER BY created_at DESC,rowid DESC) rn
      FROM inventory_movements WHERE deleted_at IS NULL
    )
    SELECT p.id,p.tenant_id,p.name,p.sku,p.barcode,p.qty_on_hand,p.updated_at product_updated_at,
      m.qty_after last_movement_quantity,m.created_at movement_at,m.source_type,m.source_id,
      s.session_name inventory_name,s.status inventory_status,s.completed_at inventory_completed_at,
      i.counted_stock inventory_count,i.was_counted,
      CASE WHEN s.deleted_at IS NULL AND s.status='completed' AND i.was_counted=1
        AND abs(i.counted_stock-m.qty_after)<0.00001 THEN 1 ELSE 0 END inventory_confirms_movement
    FROM products p JOIN latest m ON m.product_id=p.id AND m.tenant_id=p.tenant_id AND m.rn=1
    LEFT JOIN inventory_sessions s ON m.source_type='inventory' AND s.id=m.source_id AND s.tenant_id=p.tenant_id
    LEFT JOIN inventory_items i ON i.session_id=s.id AND i.tenant_id=p.tenant_id AND i.product_id=p.id AND i.deleted_at IS NULL
    WHERE p.deleted_at IS NULL AND p.is_service=0 AND abs(p.qty_on_hand-m.qty_after)>0.00001
    ORDER BY m.created_at DESC,p.id
  `).all()
  const report = {
    created_at: new Date().toISOString(),
    warning: 'Це перелік для звірки, не готові виправлення. Останній рух може не містити всієї старої історії. Залишки НЕ змінені.',
    integrity: db.prepare('PRAGMA quick_check').all(),
    foreign_key_errors: db.prepare('SELECT count(*) n FROM pragma_foreign_key_check').get().n,
    mismatch_count: mismatches.length,
    inventory_confirmed_count: mismatches.filter(row => row.inventory_confirms_movement === 1).length,
    negative_products: db.prepare('SELECT id,name,sku,barcode,qty_on_hand FROM products WHERE deleted_at IS NULL AND is_service=0 AND qty_on_hand<0').all(),
    mismatches,
  }
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report,null,2), { flag: 'wx', encoding: 'utf8' })
  console.log(JSON.stringify({ mismatch_count: report.mismatch_count, inventory_confirmed_count: report.inventory_confirmed_count, negative_products: report.negative_products.length, reportPath: reportPath ?? null }))
} finally { db.exec('ROLLBACK'); db.close() }
