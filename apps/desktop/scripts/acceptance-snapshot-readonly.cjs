// Acceptance audit: opens a standalone snapshot read-only, never LocalDatabase.
// Runtime reports use a query-only facade. No migrations, sync or live writes.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { fileURLToPath } = require('node:url')
const { DatabaseSync } = require('node:sqlite')

const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const format = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
})
function dayOf(value) {
  const date = new Date(value)
  assert(Number.isFinite(date.getTime()), 'Invalid historical timestamp')
  const parts = format.formatToParts(date)
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key).value).join('-')
}
function dayBounds(day) {
  // This acceptance corpus is deliberately bounded to Kyiv summer time 2026.
  // DST and winter boundaries are covered by reportDateConsistency.test.ts.
  assert(day >= '2026-07-01' && day <= '2026-10-12', 'Outside reviewed calendar corpus')
  return { date_from: day + 'T00:00:00.000+03:00', date_to: day + 'T23:59:59.999+03:00' }
}
function inspect(source, compiledRoot) {
  assert(path.isAbsolute(source) && path.isAbsolute(compiledRoot))
  source = fs.realpathSync(source)
  assert(!/[\\/]data[\\/]forsage\.db$/i.test(source), 'Use a standalone backup, not the live DB')
  for (const suffix of ['-wal', '-shm', '-journal']) assert(!fs.existsSync(source + suffix))
  const before = hash(source), started = performance.now()
  const { DEFAULT_TENANT_ID: tenant } = require(path.join(compiledRoot, 'db/localTypes.js'))
  const { LocalPosReports } = require(path.join(compiledRoot, 'repositories/pos/reports.js'))
  const { localAnalytics } = require(path.join(compiledRoot, 'repositories/localAnalytics.js'))
  const db = new DatabaseSync(source, { readOnly: true, timeout: 2000 })
  const mismatches = [], blocked = [], readings = []
  try {
    db.exec('PRAGMA query_only=ON; BEGIN')
    assert.equal(db.prepare('PRAGMA query_only').get().query_only, 1)
    const facade = { prepare: sql => db.prepare(sql), readSnapshot: callback => callback() }
    // The report class only assigns db in its constructor. Do not instantiate
    // LocalPosRepository: its constructor can repair interrupted fiscal intents.
    const reports = new LocalPosReports(facade)
    const sales = db.prepare("SELECT id,total,COALESCE(completed_at,created_at) at FROM sales WHERE tenant_id=? AND deleted_at IS NULL AND status IN ('completed','returned')").all(tenant)
    const returns = db.prepare("SELECT id,sale_id,created_at at,refund_kopecks amount,stock_action FROM customer_returns WHERE tenant_id=? AND deleted_at IS NULL AND status='completed'").all(tenant)
    const lines = db.prepare('SELECT id,sale_id,qty,purchase_price,total FROM sale_items WHERE tenant_id=? AND deleted_at IS NULL').all(tenant)
    const refundLines = db.prepare('SELECT return_id,sale_item_id,quantity,total_kopecks FROM customer_return_items WHERE tenant_id=? AND deleted_at IS NULL').all(tenant)
    const bySale = new Map(), byReturn = new Map(), byLine = new Map(lines.map(line => [line.id, line]))
    for (const line of lines) { const group = bySale.get(line.sale_id) || []; group.push(line); bySale.set(line.sale_id, group) }
    for (const line of refundLines) { const group = byReturn.get(line.return_id) || []; group.push(line); byReturn.set(line.return_id, group) }
    const bySaleId = new Map(sales.map(sale => [sale.id, sale]))
    const invalidSales = new Set(sales.filter(sale => {
      const group = bySale.get(sale.id) || []
      return !group.length || group.some(line => !Number.isSafeInteger(line.purchase_price) || line.purchase_price < 0 || !(line.qty > 0))
        || group.reduce((sum, line) => sum + line.total, 0) < sale.total
    }).map(sale => sale.id))
    function same(day, report, field, actual, expected, tolerance = 0) {
      if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) mismatches.push({ day, report, field, delta: actual - expected })
    }
    for (let instant = Date.parse('2026-07-01T12:00:00Z'); instant <= Date.parse('2026-10-12T12:00:00Z'); instant += 86400000) {
      const day = new Date(instant).toISOString().slice(0, 10), range = dayBounds(day)
      const selected = sales.filter(sale => dayOf(sale.at) === day)
      const refunded = returns.filter(refund => dayOf(refund.at) === day)
      const incomplete = selected.some(sale => invalidSales.has(sale.id)) || refunded.some(refund => {
        const group = byReturn.get(refund.id) || []
        return !bySaleId.has(refund.sale_id) || invalidSales.has(refund.sale_id) || !group.length
          || group.reduce((sum, line) => sum + line.total_kopecks, 0) !== refund.amount
          || group.some(line => !byLine.has(line.sale_item_id))
      })
      const gross = selected.reduce((sum, sale) => sum + sale.total, 0)
      const refund = refunded.reduce((sum, row) => sum + row.amount, 0)
      const net = gross - refund
      // Independent integer quantity oracle (thousandths), no production helper.
      let cost1000 = 0n
      if (!incomplete) {
        for (const sale of selected) for (const line of bySale.get(sale.id)) cost1000 += BigInt(Math.round(line.qty * 1000)) * BigInt(line.purchase_price)
        for (const returned of refunded) if (returned.stock_action === 'return_to_stock') {
          for (const line of byReturn.get(returned.id)) cost1000 -= BigInt(Math.round(line.quantity * 1000)) * BigInt(byLine.get(line.sale_item_id).purchase_price)
        }
      }
      const cost = Number(cost1000) / 1000
      const result = { day, receipts: selected.length, returns: refunded.length, incomplete, reports: {} }
      const runners = {
        dashboard: () => reports.dashboardSummary(range).analytics,
        period: () => reports.salesPeriodReport(range),
        staff: () => localAnalytics(facade, { kind: 'staff', from: range.date_from, to: range.date_to, startDate: day, endDate: day }),
        sold: () => reports.soldItemsReport(range),
      }
      for (const [kind, run] of Object.entries(runners)) {
        try {
          const output = run(); result.reports[kind] = 'read'
          if (incomplete) { mismatches.push({ day, report: kind, field: 'accepted-incomplete-data' }); continue }
          if (kind === 'dashboard') {
            same(day, kind, 'gross_revenue', output.gross_revenue, gross)
            same(day, kind, 'refund_total', output.refund_total, refund)
            same(day, kind, 'total_revenue', output.total_revenue, net)
            same(day, kind, 'cogs', output.cogs, cost, 0.00001)
            same(day, kind, 'receipts', output.total_receipts, selected.length)
          } else if (kind === 'period') {
            same(day, kind, 'total_revenue', output.total_revenue, gross)
            same(day, kind, 'returns_total', output.returns_total, refund)
            same(day, kind, 'net_revenue', output.net_revenue, net)
            same(day, kind, 'profit', output.profit, net - Math.round(cost))
            same(day, kind, 'receipts', output.total_sales, selected.length)
          } else if (kind === 'staff') same(day, kind, 'net_revenue', output.reduce((sum, row) => sum + row.total_revenue, 0), net)
          else assert.equal(new Set(output.map(row => row.product_id)).size, output.length, 'Duplicate sold product rows')
        } catch (error) {
          result.reports[kind] = 'blocked'
          blocked.push({ day, report: kind, knownIncomplete: incomplete, reason: String(error.message).slice(0, 160) })
        }
      }
      readings.push(result)
    }
    const photoRows = db.prepare("SELECT photo_url FROM products WHERE photo_url LIKE 'file:%'").all()
    const photoStatus = { references: photoRows.length, existing: 0, missing: 0, invalid: 0, embedded: 0 }
    for (const row of photoRows) {
      try { if (fs.statSync(fileURLToPath(row.photo_url)).isFile()) photoStatus.existing++; else photoStatus.missing++ }
      catch (error) { if (error.code === 'ENOENT') photoStatus.missing++; else photoStatus.invalid++ }
    }
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='backup_assets'").get()) {
      photoStatus.embedded = db.prepare('SELECT COUNT(*) n FROM backup_assets WHERE bytes IS NOT NULL').get().n
    }
    const summary = { source: path.basename(source), sourceHash: before, days: readings.length,
      fullyReadableDays: readings.filter(row => Object.values(row.reports).every(value => value === 'read')).length,
      incompleteReceipts: invalidSales.size, comparisonsDifferent: mismatches.length, mismatches, blocked,
      unexpectedBlocked: blocked.filter(row => !row.knownIncomplete).length,
      photoStatus, elapsedMs: Math.round(performance.now() - started), sourceUnchanged: true }
    return summary
  } finally {
    db.exec('ROLLBACK'); db.close()
    assert.equal(hash(source), before, 'Snapshot changed during read-only audit')
  }
}
module.exports = { dayOf, dayBounds, inspect }
if (require.main === module) {
  try { console.log(JSON.stringify(inspect(process.argv[2], process.argv[3]), null, 2)) }
  catch (error) { console.error(error.name, error.message); process.exitCode = 1 }
}
