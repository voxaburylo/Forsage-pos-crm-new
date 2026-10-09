// Synthetic inputs in separate Node processes; no database, files or network writes.
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const assert = require('node:assert/strict')
const { createSupplierCatalogManifest } = require('../dist/lib/supplierCatalogManifest')
const count = 100000, tenant = 'benchmark', cursor = '2026-10-09T10:00:00Z'
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
function measure(mode) {
  const items = Array.from({ length: count }, (_, i) => ({ id: 'i' + i, tenant_id: tenant,
    name: 'Олива моторна 5W30 🛢️ ' + i, brand: 'Example', sku: 'SKU-' + i, barcode: null,
    supplier_id: 'supplier', qty: '0.125', price_kopecks: 12345, warehouse_name: 'Головний',
    created_at: cursor, updated_at: cursor, deleted_at: null }))
  const imports = [{ id: 'import', tenant_id: tenant, filename: 'synthetic.csv', total_rows: count, processed_rows: count }]
  global.gc?.()
  const before = process.memoryUsage(), start = performance.now()
  let sha256
  if (mode === 'legacy') {
    // Include the same ID/tenant pass used by the previous manifest creator.
    for (const rows of [items, imports]) {
      const ids = new Set()
      for (const row of rows) {
        if (!row || typeof row.id !== 'string' || !row.id.trim()
          || row.tenant_id !== tenant || ids.has(row.id)) throw new Error('Invalid fixture')
        ids.add(row.id)
      }
    }
    const scope = { version: 1, mode: 'full', since: null, tenant_id: tenant, cursor, item_count: count, import_count: 1 }
    sha256 = createHash('sha256').update(JSON.stringify(canonical({ ...scope, items, imports }))).digest('hex')
  } else sha256 = createSupplierCatalogManifest(tenant, cursor, items, imports).sha256
  const elapsedMs = Math.round(performance.now() - start), after = process.memoryUsage()
  return { mode, count, sha256, elapsedMs, rssBefore: before.rss, rssAfter: after.rss,
    heapGrowth: after.heapUsed - before.heapUsed, peakRssKiB: process.resourceUsage().maxRSS }
}
if (process.argv[2]) console.log(JSON.stringify(measure(process.argv[2])))
else {
  const result = ['legacy', 'incremental'].map(mode => {
    const child = spawnSync(process.execPath, ['--expose-gc', __filename, mode], { encoding: 'utf8', windowsHide: true })
    if (child.status !== 0) throw new Error(child.stderr || 'benchmark failed')
    return JSON.parse(child.stdout)
  })
  assert.equal(result[0].sha256, result[1].sha256)
  console.log(JSON.stringify({ ok: true, result }, null, 2))
}
