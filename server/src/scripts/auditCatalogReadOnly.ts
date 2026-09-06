import 'dotenv/config'
import { pool } from '../db/pg.js'
import { catalogListQuery } from '../repositories/catalogListQuery.js'
import { productListSchema } from '../validators/productValidator.js'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'

// Diagnostic only: no migrations, repairs, queue sends, or business writes.
const tenantId = process.argv[2]
if (!tenantId || !/^[a-f0-9-]{36}$/i.test(tenantId)) throw new Error('Pass the shop tenant UUID')
const client = await pool.connect()
try {
  await client.query('BEGIN READ ONLY')
  await client.query("SET LOCAL statement_timeout = '15s'")
  const localPath = process.argv[3]
  if (localPath) {
    if (!path.isAbsolute(localPath)) throw new Error('Local database path must be absolute')
    const local = new DatabaseSync(localPath, { readOnly: true })
    try {
      const localRows = local.prepare(`SELECT id, qty_on_hand, retail_price FROM products
        WHERE tenant_id=? AND deleted_at IS NULL AND is_active=1`).all(tenantId) as
        Array<{ id: string; qty_on_hand: number; retail_price: number }>
      const remoteRows = (await client.query(`SELECT id, qty_on_hand, retail_price FROM products
        WHERE tenant_id=$1 AND deleted_at IS NULL AND is_active=true`, [tenantId])).rows
      const remote = new Map(remoteRows.map(p => [p.id, p]))
      const ids = new Set(localRows.map(p => p.id))
      console.log(JSON.stringify({
        comparison: 'local vs remote (read-only)', local: localRows.length, remote: remote.size,
        missingRemote: localRows.filter(p => !remote.has(p.id)).length,
        missingLocal: remoteRows.filter(p => !ids.has(p.id)).length,
        differentStock: localRows.filter(p => remote.has(p.id) && Math.abs(p.qty_on_hand - Number(remote.get(p.id).qty_on_hand)) > 0.00001).length,
        differentPrice: localRows.filter(p => remote.has(p.id) && p.retail_price !== Number(remote.get(p.id).retail_price)).length,
      }))
    } finally { local.close() }
  }
  for (const search of ['', 'фільтр', 'масло', 'booster', '2003093555486']) {
    const query = catalogListQuery(productListSchema.parse({ search, per_page: 2000 }), tenantId, search ? [search] : [])
    const started = performance.now()
    const { rows } = await client.query(query)
    const products = rows[0].data as Array<{ qty_available: number; is_service: boolean }>
    const available = (p: typeof products[number]) => p.qty_available > 0 || p.is_service
    const firstAbsent = products.findIndex(p => !available(p))
    const ordered = firstAbsent < 0 || !products.slice(firstAbsent).some(available)
    console.log(JSON.stringify({ search, total: rows[0].total, returned: products.length, ordered, ms: Math.round(performance.now() - started) }))
    if (!ordered) throw new Error('Availability order violated')
  }
} finally {
  await client.query('ROLLBACK')
  client.release()
  await pool.end()
}
