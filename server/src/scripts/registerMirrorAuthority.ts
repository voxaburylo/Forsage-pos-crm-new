/** Run only after owner approval, with a snapshot from the actual primary desktop. */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { verify } from 'node:crypto'
import { pool, runTransaction } from '../db/pg.js'
import { applyBalanceSnapshot, validateBalanceSnapshot } from '../services/sync/balanceMirror.js'

async function main() {
  const file=process.argv[process.argv.indexOf('--file')+1]
  if (!process.argv.includes('--file') || !file) throw Error('Required --file signed-snapshot.json [--apply]')
  const data=JSON.parse(readFileSync(file,'utf8'))
  validateBalanceSnapshot(data.snapshot)
  const {signature,...snapshot}=data.snapshot
  if(!verify(null,Buffer.from(JSON.stringify({tenant_id:data.tenant_id,device_id:data.device_id,snapshot})),data.public_key,Buffer.from(signature,'base64'))) throw Error('Invalid source signature')
  const state=await pool.query('SELECT device_id,public_key FROM local_mirror_authorities WHERE tenant_id=$1',[data.tenant_id])
  if(state.rows[0] && (state.rows[0].device_id!==data.device_id || state.rows[0].public_key!==data.public_key)) throw Error('Existing authority differs; explicit key rotation required')
  console.log({registered:Boolean(state.rowCount),products:snapshot.products.length,customers:snapshot.customers.length,source_version:snapshot.source_version})
  if(!process.argv.includes('--apply')) return
  await runTransaction(async client=>{
    await client.query('INSERT INTO local_mirror_authorities(tenant_id,device_id,public_key) VALUES ($1,$2,$3) ON CONFLICT(tenant_id) DO NOTHING',[data.tenant_id,data.device_id,data.public_key])
  })
  await applyBalanceSnapshot(data.tenant_id,data.device_id,data.snapshot)
  const count=await pool.query('SELECT entity_type,count(*) FROM local_balance_mirror WHERE tenant_id=$1 GROUP BY entity_type',[data.tenant_id])
  console.log('Verified canonical rows:',count.rows)
  const differences=await pool.query(`SELECT count(*) n FROM products p JOIN local_balance_mirror m ON m.tenant_id=p.tenant_id AND m.entity_id=p.id AND m.entity_type='product'
    WHERE p.tenant_id=$1 AND p.qty_on_hand IS DISTINCT FROM (m.balances->>'qty_on_hand')::numeric`,[data.tenant_id])
  if(Number(differences.rows[0].n))throw Error('Post-installation stock mismatch')
  console.log('Canonical stock differences:',differences.rows[0].n)
}
main().catch(error=>{console.error(error.message);process.exitCode=1}).finally(()=>pool.end())
