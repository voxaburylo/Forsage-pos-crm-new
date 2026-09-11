import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { attachBalanceSnapshots } from '../src/repositories/balanceSnapshot'
import { createMirrorSigner } from '../src/security/mirrorIdentity'

describe('signed outgoing local balances', () => {
  it('resolves invoice-only cancellations and retains source version after outbox pruning', () => {
    const root=mkdtempSync(path.join(tmpdir(),'forsage-mirror-doc-test-'))
    const db=new LocalDatabase(root)
    try {
      db.prepare("INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,created_at,updated_at) VALUES('product',?,'s','P',2,'2026-09-11','2026-09-11')").run(DEFAULT_TENANT_ID)
      db.prepare("INSERT INTO supply_invoices(id,tenant_id,status,created_at,updated_at) VALUES('invoice',?,'cancelled','2026-09-11','2026-09-11')").run(DEFAULT_TENANT_ID)
      db.prepare("INSERT INTO supply_invoice_items(id,tenant_id,invoice_id,product_id,qty,total,created_at,updated_at) VALUES('line',?,'invoice','product',8,100,'2026-09-11','2026-09-11')").run(DEFAULT_TENANT_ID)
      db.prepare("INSERT INTO sync_outbox(operation_id,tenant_id,device_id,aggregate_type,aggregate_id,operation_type,payload_json,status,created_at) VALUES('op',?,?,'supply_invoice','invoice','supplier_invoice.cancelled','{}','synced','2026-09-11')").run(DEFAULT_TENANT_ID,db.deviceId)
      const version=Number((db.prepare('SELECT MAX(sequence) n FROM sync_outbox').get() as any).n)
      db.exec('DELETE FROM sync_outbox')
      const operation={sequence:1,operation_id:'op',tenant_id:DEFAULT_TENANT_ID,device_id:db.deviceId,aggregate_type:'supply_invoice',aggregate_id:'invoice',operation_type:'supplier_invoice.cancelled',payload:{id:'invoice'},created_at:'2026-09-11',attempts:0,last_error:null}
      const snapshot=attachBalanceSnapshots(db,[operation])[0].payload.local_balance_snapshot
      expect(snapshot.products).toEqual([{id:'product',qty_on_hand:2}])
      expect(snapshot.source_version).toBe(version)
    } finally {db.close();rmSync(root,{recursive:true,force:true})}
  })
  it('reads current balances, not an old operation quantity, and signs outside the renderer', () => {
    const root=mkdtempSync(path.join(tmpdir(),'forsage-mirror-test-'))
    const db=new LocalDatabase(root)
    try {
      db.prepare(`INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,created_at,updated_at)
        VALUES ('product',?,'test','Test',3,'2026-09-11','2026-09-11')`).run(DEFAULT_TENANT_ID)
      const sign=createMirrorSigner(root,{ encrypt: text=>Buffer.from(text).toString('base64'), decrypt:text=>Buffer.from(text,'base64').toString() })
      const op={sequence:1,operation_id:'op',tenant_id:DEFAULT_TENANT_ID,device_id:db.deviceId,aggregate_type:'sale',aggregate_id:'sale',
        operation_type:'sale.completed',payload:{items:[{product_id:'product',qty:20}]},created_at:'2026-09-11',attempts:0,last_error:null}
      const before=db.prepare('SELECT * FROM products').all()
      const result=attachBalanceSnapshots(db,[op],sign)[0]
      const {signature,...snapshot}=result.payload.local_balance_snapshot
      expect(snapshot.products).toEqual([{id:'product',qty_on_hand:3}])
      expect(result.payload.items[0].qty).toBe(20)
      const identity=JSON.parse(readFileSync(path.join(root,'mirror-identity.json'),'utf8'))
      expect(verify(null,Buffer.from(JSON.stringify({tenant_id:DEFAULT_TENANT_ID,device_id:db.deviceId,snapshot})),identity.public_key,Buffer.from(signature,'base64'))).toBe(true)
      expect(db.prepare('SELECT * FROM products').all()).toEqual(before)
      expect(JSON.stringify(result)).not.toContain('PRIVATE KEY')
      const restarted=createMirrorSigner(root,{encrypt:()=>{throw Error('should reuse identity')},decrypt:text=>Buffer.from(text,'base64').toString()})
      expect(restarted('probe')).toBe(sign('probe'))
    } finally { db.close(); rmSync(root,{recursive:true,force:true}) }
  })
})
