// Two sequential Electron launches, synthetic users/tokens only. Never opens the shop database.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const assert = require('node:assert/strict')
function safeRoot(root) {
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('forsage-session-smoke-')) throw Error('Unsafe fixture path')
  return root
}
async function orchestrate() {
  const root = safeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-session-smoke-')))
  const childEnv = {...process.env}
  delete childEnv.ELECTRON_RUN_AS_NODE
  try {
    for (const phase of ['save','restore']) await new Promise((resolve,reject) => {
      const args = [__filename, '--phase', phase, '--fixture', root]
      if (process.argv.includes('--staged')) args.push('--staged')
      const child = spawn(require('electron'), args, {windowsHide:true,stdio:['ignore','pipe','pipe'],env:childEnv})
      child.stdout.on('data', data => process.stdout.write(data))
      child.stderr.on('data', data => process.stderr.write(data))
      const timer = setTimeout(() => { child.kill(); reject(Error('Session smoke timed out')) },30000)
      child.once('error', error => {clearTimeout(timer);reject(error)})
      child.once('exit', code => {clearTimeout(timer);code===0?resolve():reject(Error('Session '+phase+' failed: '+code))})
    })
  } finally { fs.rmSync(root,{recursive:true,force:true}) }
}
async function electronPhase() {
  const {app,safeStorage} = require('electron')
  const root = safeRoot(path.resolve(process.argv[process.argv.indexOf('--fixture')+1]))
  app.setPath('userData',path.join(root,'electron'))
  app.disableHardwareAcceleration()
  const dist = path.resolve(__dirname,process.argv.includes('--staged')?'../release/staged/win-unpacked/resources/app.asar/dist':'../dist')
  const {RememberedAccess,endOfAccessDay} = require(path.join(dist,'security/rememberedAccess'))
  const {verifyAndRememberServerSession} = require(path.join(dist,'security/serverSession'))
  const {DesktopSessionLifecycleError,serverSessionCacheResultForError} = require(path.join(dist,'security/desktopSessionLifecycle'))
  const file = path.join(root,'encrypted-day-session.txt')
  const user = {id:'fixture-cashier',tenant_id:'fixture-shop',role:'cashier',phone:'fixture',full_name:'Fixture',password_hash:'fixture-hash',is_active:1,deleted_at:null}
  const tokens = {access_token:'fixture.header.signature',refresh_token:'fixture-refresh-not-real'}
  let now = Date.parse('2026-09-29T08:00:00Z')
  const deps = {
    read:()=>fs.existsSync(file)?fs.readFileSync(file,'utf8'):null,
    write:value=>{if(value===null)fs.rmSync(file,{force:true});else fs.writeFileSync(file,value)},
    encrypt:text=>safeStorage.encryptString(text).toString('base64'),
    decrypt:text=>safeStorage.decryptString(Buffer.from(text,'base64')),
    user:(id,tenant)=>id===user.id&&tenant===user.tenant_id?user:null,
    now:()=>now,
  }
  try {
    await app.whenReady()
    assert(safeStorage.isEncryptionAvailable(),'Windows protected storage unavailable')
    const access = new RememberedAccess(deps)
    if (process.argv[process.argv.indexOf('--phase')+1]==='save') {
      access.remember(user)
      access.saveServerSession(user,tokens)
      const raw=fs.readFileSync(file,'utf8')
      assert(!raw.includes(tokens.refresh_token)&&!raw.includes(user.id))
      assert.equal(access.restore().server,undefined)
    } else {
      assert.equal(access.restore()?.id,user.id,'Day permission was not restored after full process exit')
      assert.deepEqual(access.serverSession(user),tokens)
      assert.equal(access.serverSession({...user,id:'other'}),null)
      const expires=access.status().expiresAt
      access.saveServerSession(user,{...tokens,refresh_token:'fixture-rotated'})
      assert.equal(access.status().expiresAt,expires)
      const restarted=new RememberedAccess(deps)
      assert.equal(restarted.serverSession(user).refresh_token,'fixture-rotated')
      now=endOfAccessDay(now)
      assert.equal(restarted.restore(),null)
      assert.equal(restarted.serverSession(user),null)
      let verified=0
      const options={
        current:()=>{
          if(!restarted.restore()) throw new DesktopSessionLifecycleError('local-session-ended','Day ended')
          return {id:user.id,tenant_id:user.tenant_id,generation:1}
        },
        config:{supabaseUrl:'https://fixture.invalid',supabaseAnonKey:'synthetic'},
        fetch:async()=>{
          verified++
          return new Response(JSON.stringify({id:user.id,app_metadata:{tenant_id:user.tenant_id,role:'cashier'}}),{status:200})
        },
        save:(identity,checked)=>restarted.saveServerSession(identity,checked),
      }
      for(let hour=0;hour<6;hour++) {
        now+=3600000
        assert.deepEqual(await verifyAndRememberServerSession(tokens,options),{success:false,reason:'local-session-ended'})
      }
      assert.equal(verified,0,'Expired background cache must not contact Auth')
      assert(!fs.existsSync(file),'Expired refresh must not recreate the day permission')
      const ended=new DesktopSessionLifecycleError('local-session-ended','Day ended')
      assert.deepEqual(serverSessionCacheResultForError('desktop:auth:save-server-session',ended),{success:false,reason:'local-session-ended'})
      assert.equal(serverSessionCacheResultForError('desktop:auth:restore-server-session',ended),null)
      assert.equal(serverSessionCacheResultForError('desktop:pos:checkout',ended),undefined)
      restarted.remember(user)
      const nextExpiry=restarted.status().expiresAt
      assert.deepEqual(await verifyAndRememberServerSession(tokens,options),{success:true})
      assert.equal(restarted.status().expiresAt,nextExpiry)
      assert.deepEqual(restarted.serverSession(user),tokens)
      let finish
      const delayed=verifyAndRememberServerSession(tokens,{...options,fetch:()=>new Promise(resolve=>{finish=resolve})})
      now=nextExpiry
      finish(await options.fetch())
      assert.deepEqual(await delayed,{success:false,reason:'local-session-ended'})
      assert.equal(restarted.serverSession(user),null)
      assert(!fs.existsSync(file))
      now=Date.parse('2026-09-29T08:00:00Z')
      restarted.remember(user);restarted.saveServerSession(user,tokens);restarted.forget()
      assert.equal(new RememberedAccess(deps).serverSession(user),null)
      assert(!fs.existsSync(file))
      console.log('Protected session survives a real Electron restart; identity, rotation, midnight, six expired refreshes, next-day login, delayed verification and logout checks passed.')
    }
    // Normal shutdown flushes Electron's protected storage preferences before the next process.
    app.quit()
  } catch(error) {console.error(error.message);app.exit(1)}
}
if(process.versions.electron) void electronPhase()
else orchestrate().catch(error=>{console.error(error.message);process.exitCode=1})
