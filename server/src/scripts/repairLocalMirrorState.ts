/** Explicit one-off repair. SQLite stays read-only; production schema is not changed here. */
import 'dotenv/config'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pool, runTransaction } from '../db/pg.js'
import { applyInventoryCompleted } from '../services/sync/inventoryHandlers.js'
import { applyProductUpsert } from '../services/sync/catalogHandlers.js'

async function main() {
  const args = process.argv.slice(2)
  if (!args.includes('--db')) throw new Error('Required: --db absolute-path [--apply]')
  const databasePath = path.resolve(args[args.indexOf('--db') + 1])
  const db = new DatabaseSync(databasePath, { readOnly: true })
  db.exec('PRAGMA query_only=ON; BEGIN')
  const hash = () => createHash('sha256').update(JSON.stringify({
    products: db.prepare('SELECT * FROM products ORDER BY id').all(),
    customers: db.prepare('SELECT * FROM customers ORDER BY id').all(),
    inventory: db.prepare('SELECT * FROM inventory_sessions ORDER BY id').all(),
    items: db.prepare('SELECT * FROM inventory_items ORDER BY id').all(),
  })).digest('hex')
  const beforeHash = hash()
  const products = db.prepare('SELECT * FROM products').all() as any[]
  const customers = db.prepare('SELECT id,tenant_id,debt_balance,deposit_balance,bonus_balance FROM customers').all() as any[]
  const tenantIds = [...new Set(products.map(row => row.tenant_id))]
  if (tenantIds.length !== 1) throw new Error('Expected one local tenant')
  const tenant = tenantIds[0]
  const candidates = db.prepare(`SELECT * FROM sync_outbox WHERE operation_type IN ('inventory.completed','inventory.document_copied')
    AND status IN ('pending','failed') AND tenant_id=? ORDER BY sequence`).all(tenant) as any[]
  const copies: any[] = [], rejected: any[] = []
  for (const row of candidates) {
    const payload = JSON.parse(row.payload_json)
    if (!payload.created_by) { rejected.push({ sequence: row.sequence, id: row.aggregate_id, reason: 'original_author_missing' }); continue }
    const session = db.prepare(`SELECT * FROM inventory_sessions WHERE id=? AND tenant_id=? AND status='completed' AND deleted_at IS NULL`)
      .get(row.aggregate_id, tenant) as any
    const items = db.prepare(`SELECT product_id,expected_stock,counted_stock FROM inventory_items
      WHERE session_id=? AND tenant_id=? AND was_counted=1 AND deleted_at IS NULL`).all(row.aggregate_id,tenant) as any[]
    const byId = new Map(items.map(item => [item.product_id,item]))
    if (!session || !Array.isArray(payload.items) || !payload.items.length || items.length !== payload.items.length
      || new Set(payload.items.map((item: any) => item.product_id)).size !== items.length
      || !payload.items.every((item: any) => byId.has(item.product_id)
        && typeof item.expected_stock === 'number' && item.expected_stock === Number(byId.get(item.product_id).expected_stock)
        && typeof item.counted_stock === 'number' && item.counted_stock >= 0
        && item.counted_stock === Number(byId.get(item.product_id).counted_stock))) {
      rejected.push({ sequence: row.sequence, id: row.aggregate_id }); continue
    }
    copies.push({ sequence: row.sequence, operation_id: row.operation_id, tenant_id: tenant, device_id: row.device_id,
      aggregate_type: row.aggregate_type, aggregate_id: row.aggregate_id, operation_type: 'inventory.document_copied',
      created_at: row.created_at, payload })
  }
  db.exec('ROLLBACK')
  const cloudProducts = (await pool.query('SELECT id,qty_on_hand FROM products WHERE tenant_id=$1',[tenant])).rows
  const cloudCustomers = (await pool.query('SELECT id,debt_balance,deposit_balance,bonus_balance FROM customers WHERE tenant_id=$1',[tenant])).rows
  const productMap = new Map(cloudProducts.map(row => [row.id,row]))
  const customerMap = new Map(cloudCustomers.map(row => [row.id,row]))
  const stock = products.filter(row => productMap.has(row.id) && Number(productMap.get(row.id).qty_on_hand) !== row.qty_on_hand)
    .map(row => ({ id: row.id, before_qty: Number(productMap.get(row.id).qty_on_hand), qty: row.qty_on_hand }))
  const balanceKeys = ['debt_balance','deposit_balance','bonus_balance']
  const balances = customers.filter(row => customerMap.has(row.id) && balanceKeys.some(key => Number(row[key]??0) !== Number(customerMap.get(row.id)[key]??0)))
  if (stock.some(row => !Number.isFinite(row.qty)) || balances.some(row => balanceKeys.some(key => !Number.isSafeInteger(row[key]??0)))) throw new Error('Invalid source numbers')
  const absentProducts = products.filter(row => !productMap.has(row.id)).map(row => ({id:row.id,deleted:!!row.deleted_at}))
  console.log(JSON.stringify({ stock_differences:stock.length, balance_differences:balances.length, verified_inventory_copies:copies.length, rejected, absentProducts }))
  if (args.includes('--apply')) {
    const root = path.join(path.dirname(path.dirname(databasePath)), 'backups')
    mkdirSync(root,{recursive:true})
    const file = path.join(root,'Mirror-state-repair-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json')
    const oldInventory = (await pool.query('SELECT * FROM inventory_sessions WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[tenant,copies.map(row=>row.aggregate_id)])).rows
    const oldItems = (await pool.query('SELECT * FROM inventory_items WHERE session_id=ANY($1::uuid[])',[copies.map(row=>row.aggregate_id)])).rows
    writeFileSync(file,JSON.stringify({tenant,beforeHash,stock,balances,cloudProducts,cloudCustomers,copies,oldInventory,oldItems,
      missingProductSources:products.filter(row=>!productMap.has(row.id))},null,2),{flag:'wx'})
    console.log('Backup: '+file)
    for (const row of products.filter(row=>!productMap.has(row.id)&&!row.deleted_at)) {
      const conflict = await pool.query(`SELECT id FROM products WHERE tenant_id=$1 AND
        (sku=$2 OR ($3::text IS NOT NULL AND barcode=$3))`,[tenant,row.sku,row.barcode])
      if(conflict.rowCount) throw new Error('Missing product identity conflicts with server: '+row.id)
      const payload={...row,is_active:row.is_active===1,is_service:row.is_service===1,
        is_favorite:row.is_favorite===1,requires_core_return:row.requires_core_return===1,
        specs:JSON.parse(row.specs_json??'{}'),additional_barcodes:JSON.parse(row.additional_barcodes_json??'[]')}
      await applyProductUpsert(tenant,{sequence:0,operation_id:row.id,tenant_id:tenant,device_id:'repair',
        aggregate_type:'product',aggregate_id:row.id,operation_type:'product.upsert',created_at:row.created_at,payload})
      console.log('Copied missing product '+row.id)
    }
    for (const [index,copy] of copies.entries()) {
      await applyInventoryCompleted(tenant,copy.payload.created_by,copy)
      console.log('Inventory copy '+(index+1)+'/'+copies.length)
    }
    await runTransaction(async client => {
      await client.query("SET LOCAL statement_timeout='30s'")
      await client.query("SELECT set_config('app.stock_source_type','local_mirror_repair',true)")
      await client.query("SELECT set_config('app.stock_source_id',$1,true)",[path.basename(file)])
      const result = await client.query(`UPDATE products p SET qty_on_hand=v.qty
        FROM jsonb_to_recordset($2::jsonb) AS v(id uuid,before_qty numeric,qty numeric)
        WHERE p.tenant_id=$1 AND p.id=v.id AND p.qty_on_hand IS NOT DISTINCT FROM v.before_qty RETURNING p.id`,[tenant,JSON.stringify(stock)])
      if (result.rowCount !== stock.length) throw new Error('Cloud stock changed concurrently; rolled back')
      for (const row of balances) {
        const before = customerMap.get(row.id)
        const updated = await client.query(`UPDATE customers SET debt_balance=$3,deposit_balance=$4,bonus_balance=$5
          WHERE tenant_id=$1 AND id=$2 AND (debt_balance,deposit_balance,bonus_balance) IS NOT DISTINCT FROM ($6::bigint,$7::bigint,$8::bigint) RETURNING id`,
          [tenant,row.id,...balanceKeys.map(key=>row[key]??0),...balanceKeys.map(key=>before[key]??0)])
        if (updated.rowCount !== 1) throw new Error('Cloud customer changed concurrently; rolled back')
      }
    })
  }
  const afterProducts = new Map((await pool.query('SELECT id,qty_on_hand FROM products WHERE tenant_id=$1',[tenant])).rows.map(row=>[row.id,Number(row.qty_on_hand)]))
  const differences = products.filter(row=>afterProducts.has(row.id)&&afterProducts.get(row.id)!==row.qty_on_hand)
  const remainingMissingProducts = products.filter(row=>!row.deleted_at&&!afterProducts.has(row.id)).map(row=>row.id)
  const afterCustomers = new Map((await pool.query('SELECT id,debt_balance,deposit_balance,bonus_balance FROM customers WHERE tenant_id=$1',[tenant])).rows.map(row=>[row.id,row]))
  const remainingBalanceDifferences = customers.filter(row=>!afterCustomers.has(row.id)||balanceKeys.some(key=>Number(row[key]??0)!==Number(afterCustomers.get(row.id)[key]??0))).length
  const verifiedCopies = []
  for (const copy of copies) {
    const rows=(await pool.query('SELECT product_id,expected_stock,counted_stock FROM inventory_items WHERE session_id=$1 AND was_counted=true',[copy.aggregate_id])).rows
    const m=new Map(rows.map(row=>[row.product_id,row]))
    verifiedCopies.push({id:copy.aggregate_id,matched:rows.length===copy.payload.items.length&&copy.payload.items.every((item:any)=>m.has(item.product_id)
      && Number(m.get(item.product_id).expected_stock)===item.expected_stock&&Number(m.get(item.product_id).counted_stock)===item.counted_stock)})
  }
  const localUnchanged=beforeHash===hash()
  db.close()
  console.log(JSON.stringify({remaining_stock_differences:differences.length,remainingMissingProducts,remainingBalanceDifferences,localUnchanged,inventory_verified:verifiedCopies.filter(row=>row.matched).length,
    inventory_not_matching:verifiedCopies.filter(row=>!row.matched)}))
  if(args.includes('--apply')&&(!localUnchanged||differences.length||remainingMissingProducts.length||remainingBalanceDifferences||verifiedCopies.some(row=>!row.matched))) throw new Error('Incomplete verification')
}
main().catch(error=>{console.error(error.message);process.exitCode=1}).finally(()=>pool.end())
