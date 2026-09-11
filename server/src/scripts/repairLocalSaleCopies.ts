/** Copy missing completed receipts for an explicit Kyiv date. Never opens SQLite writable. */
import 'dotenv/config'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pool } from '../db/pg.js'
import { kyivDateRange } from '../lib/businessDate.js'
import { applySaleCompleted } from '../services/sync/salesHandlers.js'

async function main() {
  const args = process.argv.slice(2)
  const value = (key: string) => args[args.indexOf(key) + 1]
  if (!args.includes('--db') || !args.includes('--date')) throw new Error('Required: --db absolute-path --date YYYY-MM-DD [--apply]')
  const databasePath = path.resolve(value('--db'))
  const day = value('--date')
  const { from, toExclusive } = kyivDateRange(day, day)
  const local = new DatabaseSync(databasePath, { readOnly: true })
  local.exec('PRAGMA query_only=ON; BEGIN')
  const stockHash = () => createHash('sha256').update(JSON.stringify(local.prepare(
    'SELECT id, tenant_id, qty_on_hand FROM products ORDER BY id').all())).digest('hex')
  const beforeStock = stockHash()
  const receipts = local.prepare(`SELECT s.*, o.sequence, o.operation_id, o.device_id, o.payload_json,
      o.created_at AS operation_created_at
    FROM sales s JOIN sync_outbox o ON o.aggregate_id=s.id AND o.tenant_id=s.tenant_id
    WHERE o.operation_type='sale.completed' AND s.deleted_at IS NULL
      AND s.status IN ('completed','returned') AND s.completed_at >= ? AND s.completed_at < ?
    ORDER BY s.completed_at`).all(from, toExclusive) as any[]
  const tenants = [...new Set(receipts.map(row => row.tenant_id))]
  if (tenants.length !== 1) throw new Error('Expected exactly one tenant with receipts')
  const tenant = tenants[0]
  const ids = receipts.map(row => row.id)
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate receipt operations require manual review')
  const operations = receipts.map(row => {
    const payload = JSON.parse(row.payload_json)
    const localItems = local.prepare('SELECT id, product_id, qty, total FROM sale_items WHERE sale_id=? AND tenant_id=? ORDER BY id').all(row.id, tenant) as any[]
    const payloadItems = [...payload.items].sort((a: any,b: any) => a.id.localeCompare(b.id))
    if (payload.sale_id !== row.id || payload.total !== row.total || Date.parse(payload.completed_at) !== Date.parse(row.completed_at)
      || payload.shift_id !== row.shift_id || localItems.length !== payloadItems.length
      || localItems.some((item, i) => ['id','product_id','qty','total'].some(key => item[key] !== payloadItems[i][key]))) {
      throw new Error('Local document and outbox disagree: ' + row.id)
    }
    return { sequence: row.sequence, operation_id: row.operation_id, device_id: row.device_id,
      tenant_id: tenant, aggregate_type: 'sale', aggregate_id: row.id, operation_type: 'sale.completed',
      created_at: row.operation_created_at, payload }
  })
  local.exec('ROLLBACK')
  const existing = (await pool.query('SELECT * FROM sales WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [tenant, ids])).rows
  const byId = new Map(existing.map(row => [row.id, row]))
  for (const row of receipts) {
    if (byId.has(row.id) && Number(byId.get(row.id)!.total) !== row.total) throw new Error('Cloud total conflict: ' + row.id)
  }
  const missing = operations.filter(op => !byId.has(op.aggregate_id))
  const missingSum = missing.reduce((sum, op) => sum + op.payload.total, 0)
  console.log(JSON.stringify({ day, local_count: receipts.length, cloud_count: existing.length,
    local_total: receipts.reduce((sum, r) => sum + r.total, 0), missing_count: missing.length, missing_total: missingSum }))
  if (args.includes('--apply') && missing.length) {
    // Save the exact source and cloud pre-state before inserting any document.
    const backupDir = path.join(path.dirname(path.dirname(databasePath)), 'backups')
    mkdirSync(backupDir, { recursive: true })
    const backup = path.join(backupDir, 'Sales-mirror-repair-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json')
    writeFileSync(backup, JSON.stringify({ day, tenant, beforeStock, operations, existing }, null, 2), { flag: 'wx' })
    console.log('Backup: ' + backup)
    for (const [index, op] of missing.entries()) {
      await applySaleCompleted(tenant, op.payload.cashier_id, op)
      if ((index + 1) % 5 === 0 || index + 1 === missing.length) console.log('Copied ' + (index + 1) + '/' + missing.length)
    }
  }
  const verified = (await pool.query(`SELECT count(*)::int AS count, sum(total)::bigint AS total,
    sum(cash_amount)::bigint AS cash, sum(transfer_amount)::bigint AS transfer
    FROM sales WHERE tenant_id=$1 AND id=ANY($2::uuid[])`, [tenant, ids])).rows[0]
  const missingItems = (await pool.query('SELECT sale_id, count(*)::int AS count FROM sale_items WHERE tenant_id=$1 AND sale_id=ANY($2::uuid[]) GROUP BY sale_id', [tenant, ids])).rows
  const counts = new Map(missingItems.map(row => [row.sale_id, row.count]))
  const complete = verified.count === receipts.length && Number(verified.total) === receipts.reduce((sum, r) => sum + r.total, 0)
    && operations.every(op => counts.get(op.aggregate_id) === op.payload.items.length)
  const localStockUnchanged = beforeStock === stockHash()
  console.log(JSON.stringify({ verified, complete, localStockUnchanged }))
  local.close()
  if (args.includes('--apply') && (!complete || !localStockUnchanged)) throw new Error('Verification incomplete; review before any further action')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(() => pool.end())
