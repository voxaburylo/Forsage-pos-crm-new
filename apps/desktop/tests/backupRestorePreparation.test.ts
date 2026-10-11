import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

const roots: string[] = []
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const photoBytes = Buffer.from('fixture photo')
const targetName = 'restored-' + hash(photoBytes) + '.jpg'
const originalUrl = 'file:///fixture/original.jpg'
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()))
    expect(path.basename(root)).toMatch(/^forsage-restore-prepare-/)
    expect(fs.realpathSync(root)).toBe(root)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'forsage-restore-prepare-'))
  roots.push(root)
  const db = new LocalDatabase(root)
  db.exec("CREATE TABLE restore_probe(value INTEGER); INSERT INTO restore_probe VALUES(98)")
  const timestamp = new Date().toISOString()
  db.prepare('INSERT INTO products(id,tenant_id,sku,name,photo_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('photo-fixture','00000000-0000-0000-0000-000000000001','PHOTO','Synthetic photo',originalUrl,timestamp,timestamp)
  let backup: string
  try {
    backup = await db.backupNow()
    db.exec('UPDATE restore_probe SET value=101')
  } finally { db.close() }
  const copy = new DatabaseSync(backup!)
  try {
    copy.exec('CREATE TABLE backup_assets(original_url TEXT PRIMARY KEY, sha256 TEXT, bytes BLOB, error TEXT)')
    copy.prepare('INSERT INTO backup_assets VALUES(?,?,?,NULL)').run(originalUrl,hash(photoBytes),photoBytes)
  } finally { copy.close() }
  const live = path.join(root,'data','forsage.db')
  return {root,backup:backup!,live,before:hash(fs.readFileSync(live)),backupHash:hash(fs.readFileSync(backup!))}
}
function unchanged(f: Awaited<ReturnType<typeof fixture>>, quarantineCreated = false) {
  expect(hash(fs.readFileSync(f.live))).toBe(f.before)
  expect(hash(fs.readFileSync(f.backup))).toBe(f.backupHash)
  if (quarantineCreated) {
    const retained = fs.readdirSync(path.join(f.root,'corrupt')).filter(name => name.endsWith('.db'))
    expect(retained).toHaveLength(1)
    expect(hash(fs.readFileSync(path.join(f.root,'corrupt',retained[0])))).toBe(f.before)
  }
  else expect(fs.existsSync(path.join(f.root,'corrupt'))).toBe(false)
  expect(fs.readdirSync(path.join(f.root,'data')).some(name => name.includes('.partial'))).toBe(false)
  const opened = LocalDatabase.open(f.root).database
  try {
    expect(opened.prepare('SELECT value FROM restore_probe').get()).toEqual({value:101})
    expect(opened.prepare('SELECT photo_url FROM products').get()).toEqual({photo_url:originalUrl})
  } finally { opened.close() }
}

it.each(['different-bytes','directory','photo-root-file','redirected-root'])(
  'rejects %s before moving the current database', async conflict => {
    const f = await fixture(), photos = path.join(f.root,'photos')
    if (conflict === 'photo-root-file') fs.writeFileSync(photos,'not a directory')
    else if (conflict === 'redirected-root') {
      const external = path.join(f.root,'external')
      fs.mkdirSync(external)
      fs.symlinkSync(external,photos,process.platform === 'win32' ? 'junction' : 'dir')
    } else {
      fs.mkdirSync(photos)
      if (conflict === 'directory') fs.mkdirSync(path.join(photos,targetName))
      else fs.writeFileSync(path.join(photos,targetName),'unrelated bytes')
    }
    expect(() => LocalDatabase.stageBackupForRestart(f.root,path.basename(f.backup))).toThrow()
    unchanged(f)
  },
)

it('refuses an unwritable photo before swapping the database and retries after the failure is removed', async () => {
  const f = await fixture(), photos = path.join(f.root,'photos')
  fs.mkdirSync(photos)
  const write = fs.writeFileSync
  const blocked = vi.spyOn(fs,'writeFileSync').mockImplementation((...args: Parameters<typeof write>) => {
    if (typeof args[0] === 'number') throw new Error('fixture photo disk full')
    return write(...args)
  })
  expect(() => LocalDatabase.stageBackupForRestart(f.root,path.basename(f.backup))).toThrow('fixture photo disk full')
  unchanged(f)
  blocked.mockRestore()
  LocalDatabase.stageBackupForRestart(f.root,path.basename(f.backup))
  const opened = LocalDatabase.open(f.root).database
  try {
    expect(opened.prepare('SELECT value FROM restore_probe').get()).toEqual({value:98})
    const photo = opened.prepare('SELECT photo_url FROM products').get()!.photo_url as string
    expect(fs.readFileSync(fileURLToPath(photo))).toEqual(photoBytes)
  } finally { opened.close() }
  expect(hash(fs.readFileSync(f.backup))).toBe(f.backupHash)
})

it('cleans a partial copy after disk-full without touching the backup or current database', async () => {
  const f = await fixture()
  const copy = fs.copyFileSync
  vi.spyOn(fs,'copyFileSync').mockImplementation((from,to,mode) => {
    if (String(to).endsWith('.db.partial')) {
      fs.writeFileSync(to,'partial bytes')
      throw new Error('fixture copy disk full')
    }
    return copy(from,to,mode)
  })
  expect(() => LocalDatabase.stageBackupForRestart(f.root,path.basename(f.backup))).toThrow('fixture copy disk full')
  unchanged(f)
})

it('keeps the current database when flushing the prepared file to disk fails', async () => {
  const f = await fixture()
  const open = fs.openSync, flush = fs.fsyncSync
  let preparedFd: number | undefined
  vi.spyOn(fs,'openSync').mockImplementation((...args: Parameters<typeof open>) => {
    const fd = open(...args)
    if (String(args[0]).endsWith('.db.partial')) preparedFd = fd
    return fd
  })
  vi.spyOn(fs,'fsyncSync').mockImplementation(fd => {
    if (fd === preparedFd) throw new Error('fixture flush failed')
    return flush(fd)
  })
  expect(() => LocalDatabase.stageBackupForRestart(f.root,path.basename(f.backup))).toThrow('fixture flush failed')
  unchanged(f)
})

it('rolls back a photo SQL failure before moving the current database', async () => {
  const f = await fixture(), copy = new DatabaseSync(f.backup)
  try {
    copy.exec("CREATE TRIGGER fail_photo_relink BEFORE UPDATE OF photo_url ON products BEGIN SELECT RAISE(ABORT,'fixture relink failure'); END")
  } finally { copy.close() }
  f.backupHash = hash(fs.readFileSync(f.backup))
  expect(() => LocalDatabase.stageBackupForRestart(f.root,path.basename(f.backup))).toThrow('fixture relink failure')
  unchanged(f)
})

it('keeps the previous database in place when publishing the fully prepared file fails', async () => {
  const f = await fixture(), rename = fs.renameSync
  vi.spyOn(fs,'renameSync').mockImplementation((from,to) => {
    if (String(from).endsWith('.db.partial')) throw new Error('fixture rename denied')
    return rename(from,to)
  })
  expect(() => LocalDatabase.stageBackupForRestart(f.root,path.basename(f.backup))).toThrow('fixture rename denied')
  unchanged(f,true)
})

it('does not replace a successfully restored photo that already has the expected bytes', async () => {
  const f = await fixture(), photos = path.join(f.root,'photos')
  fs.mkdirSync(photos)
  fs.writeFileSync(path.join(photos,targetName),photoBytes)
  const write = fs.writeFileSync
  vi.spyOn(fs,'writeFileSync').mockImplementation((...args: Parameters<typeof write>) => {
    if (String(args[0]) === path.join(photos,targetName)) throw new Error('Existing photo must not be rewritten')
    return write(...args)
  })
  LocalDatabase.stageBackupForRestart(f.root,path.basename(f.backup))
  const opened = LocalDatabase.open(f.root).database
  try { expect(opened.prepare('SELECT value FROM restore_probe').get()).toEqual({value:98}) }
  finally { opened.close() }
  expect(hash(fs.readFileSync(f.backup))).toBe(f.backupHash)
})

it.each(['no-assets','unavailable-assets'])('restores a %s snapshot without requiring an unused photo directory', async kind => {
  const f = await fixture(), copy = new DatabaseSync(f.backup)
  try {
    if (kind === 'no-assets') copy.exec('DROP TABLE backup_assets')
    else copy.exec("UPDATE backup_assets SET bytes=NULL,sha256=NULL,error='Unavailable source'")
  } finally { copy.close() }
  fs.writeFileSync(path.join(f.root,'photos'),'not used for this backup')
  LocalDatabase.stageBackupForRestart(f.root,path.basename(f.backup))
  const opened = LocalDatabase.open(f.root).database
  try {
    expect(opened.prepare('SELECT value FROM restore_probe').get()).toEqual({value:98})
    expect(opened.prepare('SELECT photo_url FROM products').get()).toEqual({photo_url:originalUrl})
  } finally { opened.close() }
})

it('prepares and verifies the complete restored photo before replacing the current database', async () => {
  const f = await fixture(), photos = path.join(f.root,'photos')
  const rename = fs.renameSync
  let moved = false
  vi.spyOn(fs,'renameSync').mockImplementation((from,to) => {
    if (String(to) === f.live) {
      moved = true
      expect(fs.readFileSync(path.join(photos,targetName))).toEqual(photoBytes)
    }
    return rename(from,to)
  })
  LocalDatabase.stageBackupForRestart(f.root,path.basename(f.backup))
  expect(moved).toBe(true)
  const opened = LocalDatabase.open(f.root).database
  try {
    expect(opened.prepare('SELECT value FROM restore_probe').get()).toEqual({value:98})
    expect(opened.prepare('SELECT photo_url FROM products').get()).toEqual({photo_url:pathToFileURL(path.join(photos,targetName)).href})
  } finally { opened.close() }
  expect(hash(fs.readFileSync(f.backup))).toBe(f.backupHash)
})
