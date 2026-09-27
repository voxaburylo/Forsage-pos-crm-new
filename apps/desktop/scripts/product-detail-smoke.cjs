// Isolated packaged-runtime check. No shop database, network or printer access.
const { mkdtempSync, rmSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const dist = path.resolve(__dirname, process.argv.includes('--packaged') ? '../release/win-unpacked/resources/app.asar/dist' : '../dist')
const { LocalDatabase } = require(path.join(dist, 'db/localDatabase'))
const { LocalCatalogRepository } = require(path.join(dist, 'repositories/catalogRepository'))
const { LocalWarehouseRepository } = require(path.join(dist, 'repositories/warehouseRepository'))
const { isDesktopChannelAllowed } = require(path.join(dist, 'security/desktopAuthorization'))
const root = mkdtempSync(path.join(tmpdir(), 'forsage-detail-packaged-'))
let db
try {
  for (const file of ['main.js', 'preload.js']) assert.ok(readFileSync(path.join(dist, file), 'utf8').includes('desktop:catalog:change-cross-numbers'))
  assert.equal(isDesktopChannelAllowed('desktop:catalog:change-cross-numbers', 'cashier'), true)
  assert.equal(isDesktopChannelAllowed('desktop:catalog:change-cross-numbers', 'tire_worker'), false)
  db = new LocalDatabase(root)
  let catalog = new LocalCatalogRepository(db)
  for (const [id, sku] of [['a', 'W67/1'], ['b', 'OC195']]) catalog.saveProduct({
    id, sku, name: 'Fixture ' + sku, qty_on_hand: 5, retail_price: 12000, purchase_price: 8000,
  })
  const crosses = catalog.changeCrossNumbers('a', { add: ['OC195', 'OC 195'] })
  assert.equal(crosses.length, 1)
  assert.deepEqual(catalog.listAnalogs('a').map(p => p.id), ['b'])
  assert.deepEqual(catalog.listAnalogs('b').map(p => p.id), ['a'])
  const request = { product_id: 'a', qty: 1.125, duration_days: 3, operation_id: 'lost-reply-fixture' }
  const reserved = new LocalWarehouseRepository(db).createManualReserve(request)
  db.close(); db = new LocalDatabase(root); catalog = new LocalCatalogRepository(db)
  assert.deepEqual(new LocalWarehouseRepository(db).createManualReserve(request), reserved)
  assert.deepEqual(catalog.changeCrossNumbers('a', { add: ['OC195'] }), crosses)
  assert.equal(catalog.findById('a').qty_available, 3.875)
  assert.equal(catalog.findById('a').qty_on_hand, 5)
  assert.equal(catalog.findById('a').retail_price, 12000)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_reserves').get().n, 1)
  assert.deepEqual(catalog.changeCrossNumbers('a', { removeId: crosses[0].id }), [])
  assert.deepEqual(catalog.listAnalogs('a'), [])
  console.log(JSON.stringify({ success: true, packaged: process.argv.includes('--packaged'), localCrossEdits: true, unchangedStockPrices: true, reserveRestartIdempotency: true, ipcAndPermissions: true }))
} finally {
  db?.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-detail-packaged-')) rmSync(root, { recursive: true, force: true })
}
