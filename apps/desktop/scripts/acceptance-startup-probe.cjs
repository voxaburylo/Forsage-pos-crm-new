// Explicit backup only. Startup repairs run on a private disposable copy,
// never against the store database and never through application main/network.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const [sourceArg, distArg] = process.argv.slice(2)
assert(sourceArg && distArg && path.isAbsolute(sourceArg) && path.isAbsolute(distArg))
const source = fs.realpathSync(sourceArg), dist = fs.realpathSync(distArg)
assert(!/[\\/]data[\\/]forsage\.db$/i.test(source), 'Use a standalone backup')
for (const suffix of ['-wal', '-shm', '-journal']) assert(!fs.existsSync(source + suffix))
const sourceHash = hash(source)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-startup-acceptance-'))
fs.mkdirSync(path.join(root, 'data'))
fs.copyFileSync(source, path.join(root, 'data', 'forsage.db'), fs.constants.COPYFILE_EXCL)
process.env.LOCALAPPDATA = path.join(root, 'local')
process.env.APPDATA = path.join(root, 'appData')
global.fetch = () => { throw new Error('Network disabled in startup acceptance') }
for (const name of ['node:http', 'node:https']) {
  const transport = require(name)
  transport.request = transport.get = () => { throw new Error('Network disabled in startup acceptance') }
}
const timings = [], sqlTimings = []
const time = (name, work) => {
  const start = performance.now()
  try { return work() } finally { timings.push({ name, ms: Math.round((performance.now() - start) * 100) / 100 }) }
}
function businessState(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON; BEGIN')
    const result = {}
    for (const [table, columns] of Object.entries({
      products: 'id,tenant_id,sku,name,barcode,qty_on_hand,purchase_price,retail_price,deleted_at',
      sales: 'id,tenant_id,total,status,cash_amount,card_amount,transfer_amount,debt_amount,deleted_at',
      sale_items: 'id,tenant_id,sale_id,product_id,qty,unit_price,purchase_price,total,deleted_at',
      supply_invoices: 'id,tenant_id,total,paid_amount,status,deleted_at',
      supplier_payments: 'id,tenant_id,supplier_id,amount,payment_method,deleted_at',
    })) result[table] = createHash('sha256').update(JSON.stringify(db.prepare(`SELECT ${columns} FROM ${table} ORDER BY id`).all())).digest('hex')
    db.exec('ROLLBACK'); return result
  } finally { db.close() }
}
const before = businessState(path.join(root, 'data', 'forsage.db'))
const { LocalDatabase } = require(path.join(dist, 'db/localDatabase.js'))
let db
try {
  db = time('LocalDatabase.open', () => LocalDatabase.open(root).database)
  const realPrepare = db.prepare.bind(db)
  db.prepare = sql => {
    const statement = realPrepare(sql)
    return new Proxy(statement, { get(target, key) {
      if (!['all', 'get', 'run'].includes(key)) return Reflect.get(target, key)
      return (...args) => {
        const started = performance.now()
        try { return target[key](...args) } finally {
          const ms = performance.now() - started
          if (ms >= 10) sqlTimings.push({ ms: Math.round(ms * 100) / 100, method: key, sql: sql.replace(/\s+/g, ' ').trim().slice(0, 2000) })
        }
      }
    } })
  }
  for (const [moduleName, exportName] of [
    ['catalogRepository', 'LocalCatalogRepository'], ['inventoryRepository', 'LocalInventoryRepository'],
    ['orderRepository', 'LocalOrderRepository'], ['posRepository', 'LocalPosRepository'],
    ['supplyRepository', 'LocalSupplyRepository'], ['staffRepository', 'LocalStaffRepository'],
    ['warehouseRepository', 'LocalWarehouseRepository'], ['syncRepository', 'LocalSyncRepository'],
    ['supplierCatalogRepository', 'LocalSupplierCatalogRepository'], ['problemRepository', 'LocalProblemRepository'],
  ]) {
    const Repository = time('import ' + exportName, () => require(path.join(dist, 'repositories', moduleName + '.js'))[exportName])
    if (exportName === 'LocalSyncRepository') {
      for (const method of Object.getOwnPropertyNames(Repository.prototype).filter(name => /^(recover|coalesce|wake|autoResolve)/.test(name))) {
        const original = Repository.prototype[method]
        Repository.prototype[method] = function(...args) { return time(method, () => original.apply(this, args)) }
      }
    }
    time(exportName, () => new Repository(db))
  }
  db.close(); db = null
  assert.deepEqual(businessState(path.join(root, 'data', 'forsage.db')), before, 'Business fields changed during startup')
  assert.equal(hash(source), sourceHash, 'Source backup changed')
  console.log(JSON.stringify({ success: true, shopDatabaseOpened: false, networkDisabled: true,
    sourceUnchanged: true, businessFieldsUnchanged: true, sourceHash, root, timings,
    sqlTimings: sqlTimings.sort((a, b) => b.ms - a.ms).slice(0, 15) }, null, 2))
} finally { if (db) db.close() }
