// Explicit maintenance operation. Defaults to rehearsal on a disposable COPY.
// Never constructs LocalDatabase, runs migrations, or discovers/auto-merges candidates.
const { DatabaseSync, backup } = require('node:sqlite')
const { createHash } = require('node:crypto')
const { readFileSync, writeFileSync, mkdtempSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { mergeProductsManually } = require('../dist/repositories/manualProductMerge.js')
const { AiInvoiceMatcher } = require('../dist/repositories/aiInvoiceIdentity.js')
const args = process.argv.slice(2)
const flag = name => args[args.indexOf(name) + 1]
const applying = args.includes('--apply')
if (!args.includes('--database') || !args.includes('--plan') || !args.includes('--report')) throw new Error('Required: --database ABSOLUTE_DB --plan REVIEWED_JSON --report NEW_JSON [--apply]')
const sourcePath = path.resolve(flag('--database')), planPath = path.resolve(flag('--plan')), reportPath = path.resolve(flag('--report'))
if (existsSync(reportPath)) throw new Error('Report already exists; choose a new name')
const plan = JSON.parse(readFileSync(planPath,'utf8'))
if (!Array.isArray(plan) || !plan.length || plan.length > 50) throw new Error('Expected 1–50 explicitly reviewed pairs')
const hash = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex')
const references = {sale_items:'product_id',supply_invoice_items:'product_id',customer_return_items:'product_id',warehouse_movements:'product_id',stock_reserves:'product_id',writeoff_items:'product_id',customer_order_items:'product_id',supplier_price_items:'matched_product_id',auto_purchase_rules:'product_id'}
const financial = ['sales','sale_items','sale_payments','shifts','cash_operations','supply_invoices','supply_invoice_items','supplier_payments','customer_returns','customer_return_items','writeoffs','writeoff_items','customer_orders','customer_order_items','customers']
function invariant(db) {
  return Object.fromEntries(financial.map(table => [table,hash(db.prepare('SELECT * FROM '+table+' ORDER BY id').all().map(row => {
    if (references[table]) { const copy={...row};delete copy[references[table]];delete copy.updated_at;delete copy.dirty_at;return copy }
    return row
  }))]))
}
function assertClosed() {
  if (process.platform !== 'win32') throw new Error('Live maintenance is restricted to this Windows workstation')
  const processes=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-Process | Where-Object { $_.ProcessName -like '*Forsage*' }).Count"],{encoding:'utf8',windowsHide:true}).trim()
  if (Number(processes) !== 0) throw new Error('Forsage is open. Save and close the program before applying.')
}
async function main() {
  if (applying) assertClosed()
  const input = new DatabaseSync(sourcePath,{readOnly:true})
  input.exec('PRAGMA query_only=ON')
  const destination = applying ? sourcePath : path.join(mkdtempSync(path.join(tmpdir(),'forsage-merge-rehearsal-')),'forsage.db')
  const backupPath = applying ? path.join(path.dirname(path.dirname(sourcePath)),'backups','before-confirmed-merge-'+new Date().toISOString().replace(/[:.]/g,'-')+'.db') : destination
  await backup(input,backupPath);input.close()
  const check = new DatabaseSync(backupPath,{readOnly:true})
  if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Backup quick_check failed')
  check.close()
  if (applying) assertClosed()
  const db = new DatabaseSync(destination)
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
  const device = db.prepare("SELECT value_json FROM app_meta WHERE key='device_id'").get()
  const adapter={prepare:sql=>db.prepare(sql),deviceId:JSON.parse(device.value_json),transaction:work=>{
    if(db.isTransaction){const savepoint='merge_'+Math.random().toString(16).slice(2);db.exec('SAVEPOINT '+savepoint);try{const r=work();db.exec('RELEASE '+savepoint);return r}catch(e){db.exec('ROLLBACK TO '+savepoint);db.exec('RELEASE '+savepoint);throw e}}
    db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}
  }}
  try {
    const results=adapter.transaction(()=>{
      const before=invariant(db)
      const integrityBefore=hash(db.prepare('PRAGMA foreign_key_check').all())
      const oldMovements=db.prepare('SELECT * FROM inventory_movements ORDER BY id').all()
      const historical=Object.fromEntries(['inventory_items','inventory_count_entries'].map(t=>[t,hash(db.prepare('SELECT * FROM '+t+' ORDER BY id').all())]))
      const combinedBefore=Number(db.prepare('SELECT SUM(qty_on_hand) n FROM products').get().n)
      const report=[]
      for(const item of plan) report.push(mergeProductsManually(adapter,item))
      if(JSON.stringify(invariant(db))!==JSON.stringify(before))throw new Error('Financial/document invariant changed; rolling back ALL merges')
      if(hash(db.prepare('PRAGMA foreign_key_check').all())!==integrityBefore)throw new Error('Foreign keys changed')
      if(Math.abs(Number(db.prepare('SELECT SUM(qty_on_hand) n FROM products').get().n)-combinedBefore)>0.000001)throw new Error('Combined stock changed')
      for(const row of oldMovements)if(hash(db.prepare('SELECT * FROM inventory_movements WHERE id=?').get(row.id))!==hash(row))throw new Error('Historical movement changed')
      for(const [table,value] of Object.entries(historical))if(hash(db.prepare('SELECT * FROM '+table+' ORDER BY id').all())!==value)throw new Error('Historical inventory changed')
      const changes=db.prepare('SELECT total_changes() n').get().n
      for(const item of plan)mergeProductsManually(adapter,item)
      if(db.prepare('SELECT total_changes() n').get().n!==changes)throw new Error('Idempotent replay wrote changes')
      const matcher=new AiInvoiceMatcher(adapter,plan[0].tenant_id)
      const matches=[]
      for(const item of plan) {
        const source=db.prepare('SELECT p.*,b.name brand FROM products p LEFT JOIN brands b ON b.id=p.brand_id WHERE p.id=?').get(item.source_id)
        const match=matcher.review({name:source.name,brand:source.brand,sku:source.sku})
        if(match.product_id!==item.target_id)throw new Error('Merged source still fails AI identity: '+source.sku+' '+JSON.stringify(match))
        matches.push({source:source.sku,product_id:match.product_id,status:match.status})
        const codes=db.prepare('SELECT barcode FROM product_barcodes WHERE product_id=? AND deleted_at IS NULL').all(item.target_id)
        if(source.barcode&&!codes.some(c=>c.barcode===source.barcode))throw new Error('Old barcode lost')
      }
      if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('Final quick_check failed')
      return {results:report,matches,financial_invariants:'unchanged',historical_inventory:'unchanged',historical_movements:'unchanged',total_stock:'conserved',idempotent_replay:'no writes',foreign_keys:'unchanged',quick_check:'ok'}
    })
    writeFileSync(reportPath,JSON.stringify({mode:applying?'applied':'rehearsal',database:destination,backup:backupPath,at:new Date().toISOString(),...results},null,2),{flag:'wx'})
    console.log(JSON.stringify({mode:applying?'applied':'rehearsal',merged:results.results.length,backup:backupPath,report:reportPath,database:destination,checks:'passed'}))
  } finally { db.close() }
}
main().catch(error=>{console.error(error.message);process.exitCode=1})
