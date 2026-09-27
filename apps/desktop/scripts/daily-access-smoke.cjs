// Real Windows encryption + compiled repositories; temporary SQLite only, no network.
const { app, safeStorage } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const dist = path.resolve(__dirname, process.argv.includes('--packaged') ? '../release/win-unpacked/resources/app.asar/dist' : '../dist')
const { LocalDatabase } = require(path.join(dist,'db/localDatabase.js'))
const { LocalStaffRepository } = require(path.join(dist,'repositories/staffRepository.js'))
const { RememberedAccess } = require(path.join(dist,'security/rememberedAccess.js'))
const root = fs.mkdtempSync(path.join(os.tmpdir(),'forsage-daily-access-'))
app.setPath('userData',path.join(root,'profile'))
let db,now=Date.parse('2026-09-26T08:00:00Z')
const timeout=setTimeout(()=>{console.error('Daily access smoke timeout');app.exit(1)},30000)
function access() {
  return new RememberedAccess({
    read:()=>db.prepare("SELECT value_json FROM app_meta WHERE key='windows_day_access'").get()?.value_json??null,
    write:value=>{
      if(value===null) db.prepare("DELETE FROM app_meta WHERE key='windows_day_access'").run()
      else db.prepare("INSERT INTO app_meta(key,value_json,updated_at) VALUES('windows_day_access',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").run(value,new Date(now).toISOString())
    },
    encrypt:value=>safeStorage.encryptString(value).toString('base64'),
    decrypt:value=>safeStorage.decryptString(Buffer.from(value,'base64')),
    user:(id,tenant)=>db.prepare('SELECT * FROM staff_users WHERE id=? AND tenant_id=?').get(id,tenant)??null,
    now:()=>now,
  })
}
app.whenReady().then(()=>{
  assert.equal(safeStorage.isEncryptionAvailable(),true)
  db=new LocalDatabase(path.join(root,'db'))
  let staff=new LocalStaffRepository(db)
  staff.saveServerUser({id:'test-daily-user',phone:'+380671112233',full_name:'Synthetic cashier',role:'cashier'},'test-daily-password')
  const verified=staff.loginWithPassword('+380671112233','test-daily-password')
  const row=()=>db.prepare('SELECT * FROM staff_users WHERE id=?').get(verified.id)
  access().remember(row())
  assert.equal(access().restore().id,verified.id)
  const stored=db.prepare("SELECT value_json FROM app_meta WHERE key='windows_day_access'").get().value_json
  assert.ok(!stored.includes('test-daily-password')&&!stored.includes(row().password_hash))
  db.close();db=new LocalDatabase(path.join(root,'db'));staff=new LocalStaffRepository(db)
  assert.equal(access().restore().id,verified.id,'encrypted permission survives database restart')
  now=Date.parse('2026-09-26T21:00:00Z')
  assert.equal(access().restore(),null,'new calendar day requires password')
  assert.throws(()=>staff.loginWithPassword('+380671112233','incorrect'))
  staff.loginWithPassword('+380671112233','test-daily-password');access().remember(row())
  access().forget();db.close();db=new LocalDatabase(path.join(root,'db'))
  assert.equal(access().restore(),null,'full logout survives restart')
  access().remember(row())
  db.prepare('UPDATE staff_users SET is_active=0 WHERE id=?').run(verified.id)
  assert.equal(access().restore(),null,'disabled employee loses permission')
  console.log('PASS: real Windows encrypted day access, offline password, restart, midnight, full logout, disabled employee; isolated SQLite, no live accounts or network')
  db.close();db=null;clearTimeout(timeout);app.exit(0)
}).catch(error=>{console.error(error);db?.close();clearTimeout(timeout);app.exit(1)})
process.on('exit',()=>{
  if(path.dirname(path.resolve(root))===path.resolve(os.tmpdir())&&path.basename(root).startsWith('forsage-daily-access-')) {
    try { fs.rmSync(root,{recursive:true,force:true}) } catch { /* isolated Chromium files may remain locked */ }
  }
})
