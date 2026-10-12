const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { inspect, distribute, allocation, roundedCost } = require('./acceptance-product-staff-readonly.cjs')
const compiled = path.resolve(process.argv[2] || path.join(__dirname, '../dist'))
const { LocalDatabase } = require(path.join(compiled, 'db/localDatabase.js'))
const { LocalCatalogRepository } = require(path.join(compiled, 'repositories/catalogRepository.js'))
const { LocalPosRepository } = require(path.join(compiled, 'repositories/posRepository.js'))
const { LocalPosReports } = require(path.join(compiled, 'repositories/pos/reports.js'))
const analytics = require(path.join(compiled, 'repositories/localAnalytics.js'))
const originalSold = LocalPosReports.prototype.soldItemsReport, originalAnalytics = analytics.localAnalytics
async function run() {
  assert.deepEqual([...distribute(1, [{ id: 'b', weight: 1 }, { id: 'a', weight: 1 }])], [['a', 1], ['b', 0]])
  assert.deepEqual([...allocation({ total: 250 }, [
    { id: 'a', qty: 1, total: 200, core_deposit_amount: 100 }, { id: 'b', qty: 1, total: 100 },
  ])], [['a', 175], ['b', 75]])
  assert.equal(roundedCost(1499n), 1); assert.equal(roundedCost(1500n), 2)
  assert.equal(roundedCost(-1500n), -1); assert.equal(roundedCost(-1501n), -2)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-product-oracle-'))
  let db
  try {
    db = new LocalDatabase(root)
    const product = new LocalCatalogRepository(db).saveProduct({ id: 'oracle-part', sku: 'ORACLE',
      name: 'Synthetic part', qty_on_hand: 10, unit: 'л', purchase_price: 199, retail_price: 1000 })
    const pos = new LocalPosRepository(db), shift = pos.openShift({ cashier_id: 'oracle-seller', opening_cash: 10000 })
    const sale = pos.checkout({ client_operation_id: 'oracle-sale', cashier_id: 'oracle-seller', shift_id: shift,
      items: [{ product_id: product.id, qty: .5, unit_price: 1000 }], payments: [{ method: 'cash', amount: 500 }] })
    db.prepare('UPDATE sales SET completed_at=?,created_at=? WHERE id=?').run('2026-07-03T09:00:00Z', '2026-07-03T09:00:00Z', sale.sale_id)
    const line = pos.getSaleForReturn(sale.sale_id).items[0]
    const refund = pos.createReturn({ client_operation_id: 'oracle-return', sale_id: sale.sale_id,
      approved_by: 'oracle-seller', shift_id: shift, refund_method: 'cash', stock_action: 'return_to_stock',
      items: [{ sale_item_id: line.id, product_id: product.id, quantity: .25 }] })
    db.prepare('UPDATE customer_returns SET created_at=? WHERE id=?').run('2026-07-04T09:00:00Z', refund.id)
    const selected = await db.backupNow(); db.close(); db = null
    const accepted = inspect(selected, compiled)
    assert.equal(accepted.checks.periods, 105); assert.equal(accepted.blocked.length, 0)
    for (const kind of ['money', 'seller', 'supplier']) {
      LocalPosReports.prototype.soldItemsReport = function(input) {
        const result = originalSold.call(this, input)
        if (result.length) {
          if (kind === 'money') result[0].revenue++
          if (kind === 'seller') result[0].sellers[0].qty_sold += .001
          if (kind === 'supplier') result[0].suppliers.push({ id: 'wrong-supplier', name: 'Wrong' })
        }
        return result
      }
      assert.throws(() => inspect(selected, compiled), undefined, kind + ' mutation must be detected')
    }
    LocalPosReports.prototype.soldItemsReport = originalSold
    analytics.localAnalytics = function(...args) {
      const rows = originalAnalytics(...args)
      if (rows.length) rows[0].bonus_cost++
      return rows
    }
    assert.throws(() => inspect(selected, compiled), /employee bonus_cost/)
    console.log(JSON.stringify({ success: true, syntheticOnly: true, periods: 105,
      fractionalCostAndReturn: true, coreAllocation: true, mutationChecks: 4, sourceUnchanged: true }))
  } finally {
    LocalPosReports.prototype.soldItemsReport = originalSold; analytics.localAnalytics = originalAnalytics
    db?.close()
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert(path.basename(root).startsWith('forsage-product-oracle-'))
    assert.equal(fs.realpathSync(root), root)
    fs.rmSync(root, { recursive: true, force: true })
  }
}
run().catch(error => { console.error(error.name, error.message); process.exitCode = 1 })
