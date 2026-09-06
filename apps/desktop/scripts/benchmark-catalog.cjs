const { DatabaseSync, backup } = require('node:sqlite')
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { LocalDatabase } = require('../dist/db/localDatabase.js')
const { LocalCatalogRepository } = require('../dist/repositories/catalogRepository.js')

async function main() {
  if (!process.argv[2] || !path.isAbsolute(process.argv[2])) throw new Error('Pass the absolute source DB path')
  const root = mkdtempSync(path.join(tmpdir(), 'forsage-catalog-audit-'))
  let local
  try {
    mkdirSync(path.join(root, 'data'))
    const source = new DatabaseSync(process.argv[2], { readOnly: true, timeout: 2000 })
    try { await backup(source, path.join(root, 'data', 'forsage.db')) } finally { source.close() }
    // Any search-index initialization/migrations affect only the isolated copy.
    local = new LocalDatabase(root)
    const catalog = new LocalCatalogRepository(local)
    const ready = p => p.is_service === 1 || p.qty_available > 0
    for (const query of ['', 'фільтр', 'масло', 'booster', '2003093555486']) {
      const started = performance.now()
      let offset = 0, total = 0, absent = false
      const ids = new Set()
      do {
        const page = catalog.listProducts({ query, limit: 100, offset })
        total = page.total
        for (const p of page.data) {
          if (absent && ready(p)) throw new Error(`Mixed stock groups at ${offset}`)
          if (ids.has(p.id)) throw new Error('Duplicate page item')
          if (!ready(p)) absent = true
          ids.add(p.id)
        }
        offset += 100
      } while (offset < total)
      if (ids.size !== total) throw new Error('Missing catalog page items')
      console.log(JSON.stringify({ query, total, pages: Math.ceil(offset / 100), ordered: true,
        totalMs: Math.round(performance.now() - started),
        averagePageMs: Math.round((performance.now() - started) / (offset / 100)) }))
    }
  } finally {
    local?.close()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-catalog-audit-')) {
      rmSync(root, { recursive: true, force: true })
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
