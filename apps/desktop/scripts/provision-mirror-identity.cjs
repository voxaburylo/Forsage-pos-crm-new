// Explicit administrator provisioning, no window and no local business writes.
const { app, safeStorage } = require('electron')
const { DatabaseSync } = require('node:sqlite')
const { readFileSync, writeFileSync } = require('node:fs')
const { createHash, verify } = require('node:crypto')
const path = require('node:path')
const { createMirrorSigner } = require('../dist/security/mirrorIdentity')
const root = process.argv[2]
if (!root || !path.isAbsolute(root)) throw Error('Required: absolute Forsage data root')
app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) throw Error('Windows protected storage unavailable')
  const db = new DatabaseSync(path.join(root,'data','forsage.db'), {readOnly:true})
  try {
    db.exec('PRAGMA query_only=ON; BEGIN')
    const deviceId = JSON.parse(db.prepare("SELECT value_json FROM app_meta WHERE key='device_id'").get().value_json)
    const identity = JSON.parse(readFileSync(path.join(root,'database-identity.json'),'utf8'))
    if (identity.deviceId !== deviceId) throw Error('Database identity mismatch')
    const tenants = db.prepare('SELECT DISTINCT tenant_id FROM products').all()
    if (tenants.length !== 1) throw Error('Expected one tenant')
    const tenantId = tenants[0].tenant_id
    const hash = () => createHash('sha256').update(JSON.stringify({
      products: db.prepare('SELECT * FROM products ORDER BY id').all(),
      customers: db.prepare('SELECT * FROM customers ORDER BY id').all(),
      inventory: db.prepare('SELECT * FROM inventory_sessions ORDER BY id').all(),
      items: db.prepare('SELECT * FROM inventory_items ORDER BY id').all(),
    })).digest('hex')
    const before = hash()
    const snapshot = {
      source_version: Number(db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='sync_outbox'),0) n").get().n),
      products: db.prepare('SELECT id,qty_on_hand FROM products WHERE tenant_id=? ORDER BY id').all(tenantId),
      customers: db.prepare(`SELECT id,COALESCE(debt_balance,0) debt_balance,COALESCE(deposit_balance,0) deposit_balance,
        COALESCE(bonus_balance,0) bonus_balance FROM customers WHERE tenant_id=? ORDER BY id`).all(tenantId),
    }
    const signer = createMirrorSigner(root, {
      encrypt:text=>safeStorage.encryptString(text).toString('base64'),
      decrypt:text=>safeStorage.decryptString(Buffer.from(text,'base64')),
    })
    const signedText=JSON.stringify({tenant_id:tenantId,device_id:deviceId,snapshot})
    const signature=signer(signedText)
    const publicKey=JSON.parse(readFileSync(path.join(root,'mirror-identity.json'),'utf8')).public_key
    if (!verify(null,Buffer.from(signedText),publicKey,Buffer.from(signature,'base64'))) throw Error('Signature self-check failed')
    if (before!==hash()) throw Error('Local data changed unexpectedly')
    const output=path.join(root,'backups',`Mirror-registration-${new Date().toISOString().replace(/[:.]/g,'-')}.json`)
    writeFileSync(output,JSON.stringify({tenant_id:tenantId,device_id:deviceId,public_key:publicKey,local_hash:before,
      snapshot:{...snapshot,signature}},null,2),{flag:'wx'})
    console.log(JSON.stringify({output,products:snapshot.products.length,customers:snapshot.customers.length,source_version:snapshot.source_version,localUnchanged:true}))
  } finally {db.close()}
  app.exit(0)
}).catch(error=>{console.error(error.message);app.exit(1)})
