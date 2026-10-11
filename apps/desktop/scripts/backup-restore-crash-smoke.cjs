// Abrupt process termination during a manual restore. Disposable fixtures only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const staged = process.argv.includes('--staged')
const compiled = path.resolve(__dirname, staged ? '../release/staged/win-unpacked/resources/app.asar/dist' : '../dist')
const { LocalDatabase } = require(path.join(compiled, 'db/localDatabase.js'))
const hash = value => createHash('sha256').update(value).digest('hex')
function assertFixture(root) {
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()))
  assert(path.basename(root).startsWith('forsage-restore-crash-'))
  assert.equal(fs.realpathSync(root),root)
}
if (process.argv[2] === '--child') {
  const root = path.resolve(process.argv[3]), phase = process.argv[4]
  assertFixture(root)
  const live = path.join(root,'data','forsage.db')
  const candidate = LocalDatabase.listBackups(root)[0]
  assert(candidate)
  const copy = fs.copyFileSync, rename = fs.renameSync, write = fs.writeFileSync
  const open = fs.openSync, flush = fs.fsyncSync, link = fs.linkSync, unlink = fs.unlinkSync
  const photoDescriptors = new Set(), retainedDescriptors = new Set()
  const isRetainedStaging = file => String(file).startsWith(path.join(root,'corrupt')+path.sep) && String(file).endsWith('.partial')
  const isPhotoStaging = file => String(file).startsWith(path.join(root,'photos','.restore-photo-')) && String(file).endsWith('.partial')
  fs.openSync = function(file,...args) {
    const fd = open(file,...args)
    if (isPhotoStaging(file)) photoDescriptors.add(fd)
    if (isRetainedStaging(file)) retainedDescriptors.add(fd)
    return fd
  }
  fs.fsyncSync = function(fd) {
    if (photoDescriptors.has(fd) && phase === 'before-photo-flush') process.exit(75)
    if (retainedDescriptors.has(fd) && phase === 'before-retain-flush') process.exit(75)
    const result = flush(fd)
    if (retainedDescriptors.has(fd) && phase === 'after-retain-flush') process.exit(75)
    if (photoDescriptors.has(fd) && phase === 'after-photo-flush') process.exit(75)
    return result
  }
  fs.linkSync = function(from,to) {
    if (isPhotoStaging(from) && phase === 'before-photo-publish') process.exit(75)
    if (isRetainedStaging(from) && phase === 'before-retain-publish') process.exit(75)
    const result = link(from,to)
    if (isRetainedStaging(from) && phase === 'after-retain-publish') process.exit(75)
    if (isPhotoStaging(from) && phase === 'after-photo-publish') process.exit(75)
    return result
  }
  fs.unlinkSync = function(file) {
    const result = unlink(file)
    if (isPhotoStaging(file) && phase === 'after-photo-cleanup') process.exit(75)
    return result
  }
  fs.writeFileSync = function(file,bytes,options) {
    const photoTarget = photoDescriptors.has(file)
    if (photoTarget && phase === 'partial-photo') {
      write(file,'incomplete photo',options)
      process.exit(75)
    }
    const result = write(file,bytes,options)
    if (photoTarget && phase === 'after-photo') process.exit(75)
    return result
  }
  fs.copyFileSync = function(from,to,flags) {
    if (String(from) === live) {
      if (phase === 'before-retain-copy') process.exit(75)
      if (phase === 'partial-retain-copy') {
        write(to,'unfinished previous snapshot',{flag:'wx'})
        process.exit(75)
      }
      const result = copy(from,to,flags)
      if (phase === 'after-retain-copy') process.exit(75)
      return result
    }
    if (String(to).endsWith('.db.partial')) {
      if (phase === 'before-copy') process.exit(75)
      if (phase === 'partial-copy') {
        fs.writeFileSync(to,'unfinished snapshot',{flag:'wx'})
        process.exit(75)
      }
      const result = copy(from,to,flags)
      if (phase === 'after-copy') process.exit(75)
      return result
    }
    return copy(from,to,flags)
  }
  fs.renameSync = function(from,to) {
    if (String(from).endsWith('.db.partial') && phase === 'before-publish') process.exit(75)
    const result = rename(from,to)
    if (String(from).endsWith('.db.partial') && phase === 'after-publish') process.exit(75)
    return result
  }
  LocalDatabase.stageBackupForRestart(root,candidate.fileName)
  throw Error('Crash injection was not reached')
} else {
  async function run(phase) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'forsage-restore-crash-'))
    let db
    try {
      assertFixture(root)
      db = LocalDatabase.open(root).database
      db.exec('CREATE TABLE restore_probe(value INTEGER); INSERT INTO restore_probe VALUES(98)')
      const backup = await db.backupNow()
      db.exec('UPDATE restore_probe SET value=101')
      db.close(); db = undefined
      const photo = Buffer.from('synthetic restored photo')
      const source = new DatabaseSync(backup)
      try {
        source.exec('CREATE TABLE backup_assets(original_url TEXT PRIMARY KEY,sha256 TEXT,bytes BLOB,error TEXT)')
        source.prepare('INSERT INTO backup_assets VALUES(?,?,?,NULL)').run('file:///fixture/photo.jpg',hash(photo),photo)
      } finally { source.close() }
      const backupHash = hash(fs.readFileSync(backup))
      const child = spawnSync(process.execPath,[__filename,'--child',root,phase,...(staged ? ['--staged'] : [])],{
        env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,encoding:'utf8',timeout:30000,
      })
      assert.equal(child.status,75,child.error?.message||child.stderr||child.stdout)
      assert.equal(hash(fs.readFileSync(backup)),backupHash)
      assert.equal(LocalDatabase.listBackups(root).length,1)
      const live = path.join(root,'data','forsage.db')
      assert.equal(fs.existsSync(live),true,'The working DB must never disappear')
      db = LocalDatabase.open(root).database
      assert.equal(db.prepare('SELECT value FROM restore_probe').get().value,phase === 'after-publish' ? 98 : 101)
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok')
      if (phase === 'after-publish') {
        assert.deepEqual(fs.readFileSync(path.join(root,'photos','restored-'+hash(photo)+'.jpg')),photo)
        assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='backup_assets'").get().n,0)
      }
      const retainedRoot = path.join(root,'corrupt')
      const retained = fs.existsSync(retainedRoot) ? fs.readdirSync(retainedRoot).filter(name=>name.endsWith('.db')) : []
      const retainedExpected = ['after-retain-publish','before-publish','after-publish'].includes(phase)
      assert.equal(retained.length,retainedExpected ? 1 : 0)
      if (retainedExpected) {
        const prior = new DatabaseSync(path.join(retainedRoot,retained[0]),{readOnly:true})
        try { assert.equal(prior.prepare('SELECT value FROM restore_probe').get().value,101) }
        finally { prior.close() }
      }
      if (phase.includes('photo')) {
        const target = path.join(root,'photos','restored-'+hash(photo)+'.jpg')
        const published = ['after-photo-publish','after-photo-cleanup'].includes(phase)
        assert.equal(fs.existsSync(target),published,'No incomplete bytes under the final name')
        if (published) assert.deepEqual(fs.readFileSync(target),photo)
      }
      db.close(); db = undefined
      if (phase === 'before-publish') {
        const repeated = spawnSync(process.execPath,[__filename,'--child',root,phase,...(staged ? ['--staged'] : [])],{
          env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,encoding:'utf8',timeout:30000,
        })
        assert.equal(repeated.status,75,repeated.error?.message||repeated.stderr)
        assert.equal(fs.existsSync(live),true)
        db = LocalDatabase.open(root).database
        assert.equal(db.prepare('SELECT value FROM restore_probe').get().value,101)
        db.close(); db = undefined
      }
      // Repeat the explicitly requested operation, never automatic startup recovery.
      LocalDatabase.stageBackupForRestart(root,path.basename(backup))
      db = LocalDatabase.open(root).database
      assert.equal(db.prepare('SELECT value FROM restore_probe').get().value,98)
      assert.deepEqual(fs.readFileSync(path.join(root,'photos','restored-'+hash(photo)+'.jpg')),photo)
      assert.equal(hash(fs.readFileSync(backup)),backupHash)
      return {phase,ok:true,recoveryRequired:false,retryCompleted:true,
        repeatedCrash:phase === 'before-publish',photoRetryRequiresCleanup:false}
    } finally {
      await db?.waitForBackup().catch(()=>{})
      db?.close()
      assertFixture(root)
      fs.rmSync(root,{recursive:true,force:true})
    }
  }
  ;(async()=>{
    const results = []
    for (const phase of ['before-copy','partial-copy','after-copy','partial-photo','after-photo','before-photo-flush','after-photo-flush','before-photo-publish','after-photo-publish','after-photo-cleanup','before-retain-copy','partial-retain-copy','after-retain-copy','before-retain-flush','after-retain-flush','before-retain-publish','after-retain-publish','before-publish','after-publish']) results.push(await run(phase))
    console.log(JSON.stringify({ok:true,staged,scenarios:results,shopDatabaseOpened:false,networkRequests:false,printerJobs:false}))
  })().catch(error=>{console.error(error);process.exitCode=1})
}
