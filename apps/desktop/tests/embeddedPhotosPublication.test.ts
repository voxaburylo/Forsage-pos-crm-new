import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { restoreEmbeddedPhotos } from '../src/backup/embeddedPhotos'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const photo = Buffer.from('complete synthetic photo')
const original = 'file:///fixture/original.jpg'
const fixtures: { root: string; db: DatabaseSync }[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'forsage-photo-publish-'))
  const db = new DatabaseSync(':memory:')
  const photos = path.join(root, 'photos')
  fs.mkdirSync(photos)
  db.exec('CREATE TABLE products(photo_url TEXT); CREATE TABLE backup_assets(original_url TEXT PRIMARY KEY,sha256 TEXT,bytes BLOB,error TEXT)')
  db.prepare('INSERT INTO products VALUES(?)').run(original)
  db.prepare('INSERT INTO backup_assets VALUES(?,?,?,NULL)').run(original, hash(photo), photo)
  fixtures.push({ root, db })
  return { root, db, photos, target: path.join(photos, 'restored-' + hash(photo) + '.jpg') }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    f.db.close()
    expect(path.dirname(f.root)).toBe(path.resolve(tmpdir()))
    expect(path.basename(f.root)).toMatch(/^forsage-photo-publish-/)
    expect(fs.realpathSync(f.root)).toBe(f.root)
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})
function unchanged(f: ReturnType<typeof fixture>) {
  expect(f.db.prepare('SELECT photo_url FROM products').get()).toEqual({ photo_url: original })
  expect(f.db.prepare('SELECT COUNT(*) n FROM backup_assets').get()).toEqual({ n: 1 })
  expect(f.db.isTransaction).toBe(false)
}
function restored(f: ReturnType<typeof fixture>) {
  expect(fs.readFileSync(f.target)).toEqual(photo)
  expect(f.db.prepare('SELECT photo_url FROM products').get()).toEqual({ photo_url: pathToFileURL(f.target).href })
  expect(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='backup_assets'").get()).toEqual({ n: 0 })
}

it('publishes only after writing, flushing and closing a private file; removes its staging link', () => {
  const f = fixture(), write = fs.writeFileSync, flush = fs.fsyncSync, close = fs.closeSync, link = fs.linkSync
  const events: string[] = []
  let descriptor: number | undefined
  vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof write>) => {
    expect(typeof args[0]).toBe('number')
    descriptor = args[0] as number
    expect(fs.existsSync(f.target)).toBe(false)
    events.push('write')
    return write(...args)
  })
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    expect(fd).toBe(descriptor)
    events.push('flush')
    return flush(fd)
  })
  vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
    expect(fd).toBe(descriptor)
    events.push('close')
    return close(fd)
  })
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    expect(to).toBe(f.target)
    expect(fs.readFileSync(from)).toEqual(photo)
    expect(events).toEqual(['write', 'flush', 'close'])
    expect(fs.existsSync(f.target)).toBe(false)
    events.push('publish')
    return link(from, to)
  })
  restoreEmbeddedPhotos(f.db, f.root)
  restored(f)
  expect(events).toEqual(['write', 'flush', 'close', 'publish'])
  expect(fs.readdirSync(f.photos)).toEqual([path.basename(f.target)])
  expect(fs.statSync(f.target).nlink).toBe(1)
})

it.each(['write', 'flush', 'publish'])('keeps the database and final path unchanged after %s failure, then retries', phase => {
  const f = fixture(), write = fs.writeFileSync
  if (phase === 'write') vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof write>) => {
    write(args[0], 'partial bytes')
    throw new Error('fixture disk full')
  })
  if (phase === 'flush') vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('fixture flush failure') })
  if (phase === 'publish') vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw new Error('fixture link unsupported') })
  const unsafeRename = vi.spyOn(fs, 'renameSync'), unsafeCopy = vi.spyOn(fs, 'copyFileSync')
  expect(() => restoreEmbeddedPhotos(f.db, f.root)).toThrow('fixture')
  unchanged(f)
  expect(fs.readdirSync(f.photos)).toEqual([])
  expect(unsafeRename).not.toHaveBeenCalled()
  expect(unsafeCopy).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  restoreEmbeddedPhotos(f.db, f.root)
  restored(f)
})

it.each(['same', 'different', 'directory'])('does not overwrite a concurrently published %s target', kind => {
  const f = fixture(), link = fs.linkSync
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (kind === 'directory') fs.mkdirSync(to)
    else fs.writeFileSync(to, kind === 'same' ? photo : 'unrelated user photo')
    return link(from, to) // Real filesystem EEXIST, not a manufactured success.
  })
  if (kind === 'same') {
    restoreEmbeddedPhotos(f.db, f.root)
    restored(f)
  } else {
    expect(() => restoreEmbeddedPhotos(f.db, f.root)).toThrow()
    unchanged(f)
    if (kind === 'directory') expect(fs.statSync(f.target).isDirectory()).toBe(true)
    else expect(fs.readFileSync(f.target, 'utf8')).toBe('unrelated user photo')
  }
  expect(fs.readdirSync(f.photos)).toEqual([path.basename(f.target)])
})

it.each(['same', 'different'])('verifies an existing %s photo without creating staging files', kind => {
  const f = fixture()
  fs.writeFileSync(f.target, kind === 'same' ? photo : 'do not replace')
  const open = vi.spyOn(fs, 'openSync'), link = vi.spyOn(fs, 'linkSync')
  if (kind === 'same') {
    restoreEmbeddedPhotos(f.db, f.root)
    restored(f)
  } else {
    expect(() => restoreEmbeddedPhotos(f.db, f.root)).toThrow('Конфлікт відновлення фото')
    unchanged(f)
    expect(fs.readFileSync(f.target, 'utf8')).toBe('do not replace')
  }
  expect(open).not.toHaveBeenCalled()
  expect(link).not.toHaveBeenCalled()
})

it('ignores an interrupted private staging file and does not delete files it does not own', () => {
  const f = fixture(), stale = path.join(f.photos, '.restore-photo-previous.partial')
  fs.writeFileSync(stale, 'interrupted write')
  restoreEmbeddedPhotos(f.db, f.root)
  restored(f)
  expect(fs.readFileSync(stale, 'utf8')).toBe('interrupted write')
})

it('does not remove a staging path when exclusive creation failed', () => {
  const f = fixture(), open = fs.openSync
  let collision: string | undefined
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof open>) => {
    collision = String(args[0])
    fs.writeFileSync(collision, 'existing unowned file')
    return open(...args) // wx must reject the existing path.
  })
  expect(() => restoreEmbeddedPhotos(f.db, f.root)).toThrow()
  unchanged(f)
  expect(fs.readFileSync(collision!, 'utf8')).toBe('existing unowned file')
  expect(fs.existsSync(f.target)).toBe(false)
})

it('keeps a complete final photo if only private staging cleanup fails', () => {
  const f = fixture()
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw new Error('fixture cleanup denied') })
  restoreEmbeddedPhotos(f.db, f.root)
  restored(f)
  const staged = fs.readdirSync(f.photos).filter(name => name.endsWith('.partial'))
  expect(staged).toHaveLength(1)
  expect(fs.readFileSync(path.join(f.photos, staged[0]))).toEqual(photo)
})
