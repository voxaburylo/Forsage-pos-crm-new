// Long, repeatable repository-read probe on a standalone backup. No application
// main, constructor recovery, writes, real printers, network or private output.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const [sourceArg, distArg, minutesArg = '120'] = process.argv.slice(2)
assert(path.isAbsolute(sourceArg || '') && path.isAbsolute(distArg || ''))
const source = fs.realpathSync(sourceArg), dist = fs.realpathSync(distArg)
assert(!/[\\/]data[\\/]forsage\.db$/i.test(source), 'Use a standalone backup')
for (const suffix of ['-wal', '-shm', '-journal']) assert(!fs.existsSync(source + suffix))
const minutes = Number(minutesArg)
assert(Number.isFinite(minutes) && minutes >= 0.1 && minutes <= 480)
assert(global.gc, 'Run with --expose-gc for retained-memory measurements')
const digest = value => createHash('sha256').update(value).digest('hex')
const sourceHash = digest(fs.readFileSync(source))
global.fetch = () => { throw new Error('Network disabled in read-only soak') }
const { LocalDatabase, MAX_CACHED_STATEMENTS } = require(path.join(dist, 'db/localDatabase.js'))
const { DEFAULT_TENANT_ID: tenant } = require(path.join(dist, 'db/localTypes.js'))
const { LocalCatalogRepository } = require(path.join(dist, 'repositories/catalogRepository.js'))
const { LocalPosReports } = require(path.join(dist, 'repositories/pos/reports.js'))
const { LocalSupplyRepository } = require(path.join(dist, 'repositories/supplyRepository.js'))
const { customerPhoneKey } = require(path.join(dist, 'repositories/pos/customerValidation.js'))
const sql = new DatabaseSync(source, { readOnly: true })
sql.exec('PRAGMA query_only=ON')
sql.function('forsage_lower', { deterministic: true }, value => String(value ?? '').toLocaleLowerCase('uk-UA'))
sql.function('forsage_phone', { deterministic: true }, value => customerPhoneKey(value))
const facade = Object.create(LocalDatabase.prototype)
Object.assign(facade, { database: sql, statements: new Map(), transactionSequence: 0 })
const catalog = Object.create(LocalCatalogRepository.prototype)
catalog.db = facade
const reports = new LocalPosReports(facade), supply = new LocalSupplyRepository(facade)
const day = { date_from: '2026-10-10T00:00:00+03:00', date_to: '2026-10-10T23:59:59.999+03:00' }
const week = { date_from: '2026-10-05T00:00:00+03:00', date_to: '2026-10-11T23:59:59.999+03:00' }
const productRows = rows => rows.map(({ qty_reserved, qty_available, ...row }) => row)
const tasks = [
  ...['BO 1457434310', 'WX WA9428', 'HBJ J1325037', '5449000351081', 'помпа', 'Elf', 'ремінь', '2009703825277']
    .map((query, index) => ({ name: 'catalog-' + index, run: () => productRows(catalog.searchProducts(query, tenant, 30)) })),
  { name: 'invoices-product', run: () => supply.listInvoices({ search: 'фільтр', per_page: 25, page: 1 }) },
  { name: 'invoices-page', run: () => supply.listInvoices({ per_page: 25, page: 3 }) },
  { name: 'customers', run: () => reports.listCustomers({ per_page: 25, page: 1 }) },
  { name: 'sold-day', run: () => reports.soldItemsReport(day) },
  { name: 'sold-week', run: () => reports.soldItemsReport(week) },
  { name: 'period-week', run: () => reports.salesPeriodReport(week) },
  { name: 'dashboard-day', run: () => reports.dashboardSummary(day).analytics },
]
const expected = new Map(), metrics = new Map(tasks.map(task => [task.name, []]))
const samples = []
const started = performance.now(), deadline = started + minutes * 60000
let cycles = 0, reads = 0, baselineHeap = null, baselineRss = null, lastSample = 0, retainedMemory = null
function sample() {
  global.gc()
  const memory = process.memoryUsage()
  retainedMemory = memory
  if (cycles >= 5 && baselineHeap === null) { baselineHeap = memory.heapUsed; baselineRss = memory.rss }
  const current = { seconds: Math.round((performance.now() - started) / 1000), cycles, reads,
    heapMiB: +(memory.heapUsed / 1048576).toFixed(2), rssMiB: +(memory.rss / 1048576).toFixed(2),
    cache: facade.statements.size }
  samples.push(current); lastSample = performance.now()
  assert(facade.statements.size <= MAX_CACHED_STATEMENTS, 'Statement cache exceeded its bound')
  console.log(JSON.stringify({ progress: current }))
}
(async () => {
  try {
    while (performance.now() < deadline) {
      for (const task of tasks) {
        const t = performance.now(), output = task.run()
        metrics.get(task.name).push(performance.now() - t)
        const value = digest(JSON.stringify(output))
        if (!expected.has(task.name)) expected.set(task.name, value)
        else assert.equal(value, expected.get(task.name), 'Read changed for ' + task.name)
        reads++
      }
      cycles++
      if (cycles === 5 || performance.now() - lastSample >= 60000) sample()
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    sample()
    assert.deepEqual(sql.prepare('PRAGMA quick_check').all().map(row => row.quick_check), ['ok'])
    assert.equal(sql.prepare('PRAGMA query_only').get().query_only, 1)
    assert.equal(digest(fs.readFileSync(source)), sourceHash)
    // Use the final post-GC workload sample, not the temporary source-file
    // buffer just allocated by the integrity hash above.
    const final = retainedMemory
    const statistics = [...metrics].map(([name, values]) => {
      values.sort((a, b) => a - b)
      return { name, reads: values.length, p50Ms: +values[Math.floor(values.length * .5)].toFixed(2),
        p95Ms: +values[Math.floor(values.length * .95)].toFixed(2), maxMs: +values[values.length - 1].toFixed(2) }
    })
    console.log(JSON.stringify({ success: true, readOnly: true, sourceUnchanged: true, shopDatabaseOpened: false,
      elapsedSeconds: Math.round((performance.now() - started) / 1000), cycles, reads, sourceHash,
      retainedHeapGrowthMiB: baselineHeap === null ? null : +((final.heapUsed - baselineHeap) / 1048576).toFixed(2),
      rssGrowthMiB: baselineRss === null ? null : +((final.rss - baselineRss) / 1048576).toFixed(2),
      cache: facade.statements.size, statistics, samples }, null, 2))
  } finally { facade.statements.clear(); sql.close() }
})().catch(error => { console.error(error.message); process.exitCode = 1 })
