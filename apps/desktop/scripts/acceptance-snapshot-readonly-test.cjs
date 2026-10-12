// Synthetic self-test for the audit oracle; never reads a shop database.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { inspect, dayOf, dayBounds } = require('./acceptance-snapshot-readonly.cjs')
const compiled = path.resolve(process.argv[2] || path.join(__dirname, '../dist'))
const { LocalDatabase } = require(path.join(compiled, 'db/localDatabase.js'))
const { LocalCatalogRepository } = require(path.join(compiled, 'repositories/catalogRepository.js'))
const { LocalPosRepository } = require(path.join(compiled, 'repositories/posRepository.js'))
const { LocalPosReports } = require(path.join(compiled, 'repositories/pos/reports.js'))

async function run() {
  assert.equal(dayOf('2026-09-30T21:01:00Z'), '2026-10-01')
  assert.throws(() => dayBounds('2026-10-25'), /Outside/)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-acceptance-oracle-'))
  let db
  const original = LocalPosReports.prototype.salesPeriodReport
  try {
    db = new LocalDatabase(root)
    const catalog = new LocalCatalogRepository(db), pos = new LocalPosRepository(db)
    const product = catalog.saveProduct({ id: 'oracle-product', sku: 'ORACLE', name: 'Synthetic oracle item',
      qty_on_hand: 10, unit: 'л', purchase_price: 199, retail_price: 1000 })
    const shift = pos.openShift({ cashier_id: 'oracle-cashier', opening_cash: 10000 })
    const sale = pos.checkout({ client_operation_id: 'oracle-sale', cashier_id: 'oracle-cashier', shift_id: shift,
      items: [{ product_id: product.id, qty: 0.5, unit_price: 1000 }], payments: [{ method: 'cash', amount: 500 }] })
    db.prepare('UPDATE sales SET completed_at=?,created_at=? WHERE id=?').run('2026-09-30T21:01:00Z', '2026-09-30T21:01:00Z', sale.sale_id)
    const line = pos.getSaleForReturn(sale.sale_id).items[0]
    const returned = pos.createReturn({ client_operation_id: 'oracle-refund', sale_id: sale.sale_id,
      approved_by: 'oracle-cashier', shift_id: shift, refund_method: 'cash', stock_action: 'return_to_stock',
      items: [{ sale_item_id: line.id, product_id: product.id, quantity: 0.25 }] })
    db.prepare('UPDATE customer_returns SET created_at=? WHERE id=?').run('2026-10-02T09:00:00Z', returned.id)
    const selected = await db.backupNow()
    db.close(); db = undefined
    const accepted = inspect(selected, compiled)
    assert.equal(accepted.days, 104)
    assert.equal(accepted.fullyReadableDays, 104)
    assert.equal(accepted.comparisonsDifferent, 0)
    assert.equal(accepted.unexpectedBlocked, 0)
    // Mutation proves a wrong financial total cannot pass by comparing reports
    // only to one another. The independent primary-document oracle must fail.
    LocalPosReports.prototype.salesPeriodReport = function (input) {
      const result = original.call(this, input)
      if (input.date_from.startsWith('2026-10-01')) result.net_revenue += 1
      return result
    }
    const rejected = inspect(selected, compiled)
    assert.deepEqual(rejected.mismatches, [{ day: '2026-10-01', report: 'period', field: 'net_revenue', delta: 1 }])
    assert.equal(rejected.unexpectedBlocked, 0)
    console.log(JSON.stringify({ success: true, daysPerPass: 104, passes: 2, fractionalCostAndReturn: true,
      kyivMidnight: true, injectedOneKopeckErrorDetected: true, sourceUnchanged: true }))
  } finally {
    LocalPosReports.prototype.salesPeriodReport = original
    db?.close()
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert(path.basename(root).startsWith('forsage-acceptance-oracle-'))
    assert.equal(fs.realpathSync(root), root)
    fs.rmSync(root, { recursive: true, force: true })
  }
}
run().catch(error => { console.error(error.name, error.message); process.exitCode = 1 })
