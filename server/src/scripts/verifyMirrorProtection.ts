import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { pool } from '../db/pg.js'
async function main() {
  const arg=(name:string)=>process.argv[process.argv.indexOf(name)+1]
  if(!process.argv.includes('--db')||!process.argv.includes('--file'))throw Error('Required --db read-only-local-db --file registration-snapshot')
  const registration=JSON.parse(readFileSync(arg('--file'),'utf8'))
  const local=new DatabaseSync(arg('--db'),{readOnly:true})
  try{
    local.exec('PRAGMA query_only=ON; BEGIN')
    const products=local.prepare('SELECT * FROM products ORDER BY id').all() as any[]
    const customers=local.prepare('SELECT * FROM customers ORDER BY id').all() as any[]
    const hash=createHash('sha256').update(JSON.stringify({products,customers,
      inventory:local.prepare('SELECT * FROM inventory_sessions ORDER BY id').all(),
      items:local.prepare('SELECT * FROM inventory_items ORDER BY id').all(),
    })).digest('hex')
    if(hash!==registration.local_hash)throw Error('Local business data changed since registration; inspect before further repair')
    const tenant=registration.tenant_id
    const cloudProducts=await pool.query('SELECT id,qty_on_hand FROM products WHERE tenant_id=$1',[tenant])
    const cloudCustomers=await pool.query('SELECT id,debt_balance,deposit_balance,bonus_balance FROM customers WHERE tenant_id=$1',[tenant])
    const p=new Map(cloudProducts.rows.map(row=>[row.id,row]))
    const c=new Map(cloudCustomers.rows.map(row=>[row.id,row]))
    const stockDifferences=products.filter(row=>!p.has(row.id)||Number(p.get(row.id).qty_on_hand)!==Number(row.qty_on_hand)).length
    const balanceDifferences=customers.filter(row=>!c.has(row.id)||['debt_balance','deposit_balance','bonus_balance'].some(key=>Number(c.get(row.id)[key]??0)!==Number(row[key]??0))).length
    console.log({localUnchanged:true,products:products.length,customers:customers.length,stockDifferences,balanceDifferences})
    if(stockDifferences||balanceDifferences)throw Error('Mirror verification failed')
    if(process.argv.includes('--probe')){
      const client=await pool.connect()
      try{
        await client.query('BEGIN')
        await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'")
        const product=products.find(row=>Number(row.qty_on_hand)>0)
        const changed=await client.query('UPDATE products SET qty_on_hand=qty_on_hand+7 WHERE id=$1 AND tenant_id=$2 RETURNING qty_on_hand',[product.id,tenant])
        if(Number(changed.rows[0].qty_on_hand)!==Number(product.qty_on_hand))throw Error('Stock protection probe failed')
        const customer=customers[0]
        const money=await client.query('UPDATE customers SET debt_balance=debt_balance+123 WHERE id=$1 AND tenant_id=$2 RETURNING debt_balance',[customer.id,tenant])
        if(Number(money.rows[0].debt_balance)!==Number(customer.debt_balance))throw Error('Money protection probe failed')
        console.log('Stock and money protection probes passed; all probe changes rolled back.')
      } finally {await client.query('ROLLBACK');client.release()}
    }
  } finally {local.close()}
}
main().catch(error=>{console.error(error.message);process.exitCode=1}).finally(()=>pool.end())
