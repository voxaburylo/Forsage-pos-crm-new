// Isolated packaged runtime check: no shop database, printers or network.
const { mkdtempSync, rmSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const dist = path.resolve(__dirname, process.argv.includes('--packaged') ? '../release/win-unpacked/resources/app.asar/dist' : '../dist')
const { LocalDatabase } = require(path.join(dist, 'db/localDatabase'))
const { DEFAULT_TENANT_ID } = require(path.join(dist, 'db/localTypes'))
const { LocalCatalogRepository } = require(path.join(dist, 'repositories/catalogRepository'))
const { LocalWarehouseRepository } = require(path.join(dist, 'repositories/warehouseRepository'))
const root = mkdtempSync(path.join(tmpdir(), 'forsage-warehouse-recovery-packaged-'))
let db
try {
  for (const file of ['main.js', 'preload.js']) assert.ok(readFileSync(path.join(dist, file), 'utf8').includes('desktop:warehouse:resolve-'))
  db = new LocalDatabase(root)
  let warehouse = new LocalWarehouseRepository(db)
  const user = randomUUID(), now = new Date().toISOString()
  db.prepare("INSERT INTO staff_users (id,tenant_id,full_name,role,is_active,created_at,updated_at) VALUES (?,?,'Fixture','manager',1,?,?)").run(user,DEFAULT_TENANT_ID,now,now)
  const product = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: 'FIXTURE', name: 'Oil', qty_on_hand: 8, storage_bin: 'A', purchase_price: 100 }).id
  const calls = {
    reserve: id => warehouse.createManualReserve({ operation_id:id,product_id:product,qty:1,user_id:user }),
    movement: id => warehouse.createMovement({ operation_id:id,product_id:product,qty:8,from_bin:'A',to_bin:'B',user_id:user }),
    consumption: id => warehouse.createConsumption({ operation_id:id,employee_id:user,items:[{product_id:product,qty:1.125}],user_id:user }),
  }
  for (const [kind, write] of Object.entries(calls)) {
    const cancelled = randomUUID()
    assert.deepEqual(warehouse.resolveOperation(kind, cancelled, user), {status:'not_committed'})
    db.close(); db = new LocalDatabase(root); warehouse = new LocalWarehouseRepository(db)
    assert.throws(()=>write(cancelled), /закрито без проведення/)
    const id = randomUUID(), saved = write(id)
    const before = db.prepare('SELECT qty_on_hand,storage_bin FROM products WHERE id=?').get(product)
    db.close(); db = new LocalDatabase(root); warehouse = new LocalWarehouseRepository(db)
    assert.deepEqual(warehouse.resolveOperation(kind,id,user),{status:'committed',result:saved})
    assert.deepEqual(write(id),saved)
    assert.deepEqual(db.prepare('SELECT qty_on_hand,storage_bin FROM products WHERE id=?').get(product),before)
  }
  assert.equal(db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(product).qty_on_hand,6.875)
  console.log(JSON.stringify({success:true,packaged:process.argv.includes('--packaged'),lateWriteFence:true,restartRecovery:true,stockDecrementExactlyOnce:true}))
} finally {
  db?.close()
  if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-warehouse-recovery-packaged-'))rmSync(root,{recursive:true,force:true})
}
