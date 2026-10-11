import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { embedBackupPhotos, restoreEmbeddedPhotos } from '../src/backup/embeddedPhotos'

const roots: string[] = []
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'forsage-photo-safety-'))
  roots.push(root)
  mkdirSync(path.join(root, 'photos'))
  const snapshot = path.join(root, 'snapshot.db')
  const db = new DatabaseSync(snapshot)
  db.exec('CREATE TABLE products(id TEXT PRIMARY KEY, photo_url TEXT)')
  db.close()
  return { root, snapshot }
}
function usingDb<T>(snapshot: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(snapshot)
  try { return work(db) } finally { db.close() }
}
function product(snapshot: string, id: string, url: string) {
  usingDb(snapshot, db => db.prepare('INSERT INTO products VALUES(?,?)').run(id, url))
}
function asset(snapshot: string, url: string) {
  return usingDb(snapshot, db => db.prepare('SELECT sha256, bytes, error FROM backup_assets WHERE original_url=?').get(url))
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()))
    expect(path.basename(root)).toMatch(/^forsage-photo-safety-/)
    expect(realpathSync(root)).toBe(root)
    // Recursive removal does not follow junctions; all targets are disposable fixtures.
    rmSync(root, { recursive: true, force: true })
  }
})

it('records a malformed file URL without losing the other photos or aborting the backup', async () => {
  const { root, snapshot } = fixture()
  const photo = path.join(root, 'photos', 'good.jpg'), invalid = 'file:///broken%ZZ.jpg'
  writeFileSync(photo, 'good photo')
  product(snapshot, 'invalid', invalid)
  product(snapshot, 'valid', pathToFileURL(photo).href)
  await expect(embedBackupPhotos(snapshot, root)).resolves.toBeUndefined()
  expect(asset(snapshot, invalid)).toMatchObject({ bytes: null, sha256: null, error: expect.any(String) })
  expect(asset(snapshot, pathToFileURL(photo).href)).toMatchObject({ sha256: hash('good photo'), error: null })
})

it('retries unavailable photos, preserving already captured bytes even if their source later changes', async () => {
  const { root, snapshot } = fixture()
  const original = path.join(root, 'photos', 'captured.jpg'), missing = path.join(root, 'photos', 'later.jpg')
  writeFileSync(original, 'original')
  product(snapshot, 'a', pathToFileURL(original).href)
  product(snapshot, 'b', pathToFileURL(missing).href)
  await embedBackupPhotos(snapshot, root)
  expect(asset(snapshot, pathToFileURL(missing).href)).toMatchObject({ bytes: null })
  writeFileSync(original, 'changed')
  writeFileSync(missing, 'recovered')
  await embedBackupPhotos(snapshot, root)
  expect(asset(snapshot, pathToFileURL(original).href)).toMatchObject({ sha256: hash('original') })
  expect(asset(snapshot, pathToFileURL(missing).href)).toMatchObject({ sha256: hash('recovered'), error: null })
  expect(usingDb(snapshot, db => db.prepare('SELECT count(*) n FROM backup_assets').get())).toEqual({ n: 2 })
})

it.each(['hard-link', 'junction', 'windows-case'] as const)('refuses a %s alias of the authoritative database before changing any bytes', async kind => {
  const { root, snapshot } = fixture()
  mkdirSync(path.join(root, 'data'))
  const live = path.join(root, 'data', 'forsage.db')
  writeFileSync(live, readFileSync(snapshot))
  let alias: string
  if (kind === 'hard-link') {
    alias = path.join(root, 'linked.db')
    linkSync(live, alias)
  } else if (kind === 'junction') {
    const linkedDirectory = path.join(root, 'linked-data')
    symlinkSync(path.join(root, 'data'), linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    alias = path.join(linkedDirectory, 'forsage.db')
  } else {
    alias = process.platform === 'win32' ? live.toUpperCase() : live
  }
  const before = hash(readFileSync(live))
  await expect(embedBackupPhotos(alias, root)).rejects.toThrow('Не можна пакувати робочу базу')
  expect(hash(readFileSync(live))).toBe(before)
})

it('does not create an empty database for a missing snapshot', async () => {
  const { root } = fixture(), missing = path.join(root, 'absent.db')
  await expect(embedBackupPhotos(missing, root)).rejects.toThrow()
  expect(existsSync(missing)).toBe(false)
})

it('deduplicates shared photo URLs and does not fetch remote images', async () => {
  const { root, snapshot } = fixture()
  const photo = path.join(root, 'photos', 'shared.jpg'), url = pathToFileURL(photo).href
  writeFileSync(photo, 'shared')
  product(snapshot, 'one', url)
  product(snapshot, 'two', url)
  product(snapshot, 'remote', 'https://photos.invalid/product.jpg')
  await embedBackupPhotos(snapshot, root)
  expect(usingDb(snapshot, db => db.prepare('SELECT count(*) n FROM backup_assets').get())).toEqual({ n: 1 })
  expect(asset(snapshot, url)).toMatchObject({ sha256: hash('shared') })
})

it('does not embed outside files through a nested junction or a similar directory prefix', async () => {
  const { root, snapshot } = fixture()
  const external = path.join(root, 'photos-private')
  mkdirSync(external)
  writeFileSync(path.join(external, 'private.jpg'), 'outside')
  const linked = path.join(root, 'photos', 'linked')
  symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const direct = pathToFileURL(path.join(external, 'private.jpg')).href
  const indirect = pathToFileURL(path.join(linked, 'private.jpg')).href
  product(snapshot, 'direct', direct)
  product(snapshot, 'indirect', indirect)
  await embedBackupPhotos(snapshot, root)
  for (const url of [direct, indirect]) expect(asset(snapshot, url)).toMatchObject({ bytes: null, error: expect.any(String) })
})

it('rolls back all newly captured assets on a database write failure and retries cleanly', async () => {
  const { root, snapshot } = fixture()
  const good = path.join(root, 'photos', 'good.jpg'), bad = path.join(root, 'photos', 'bad.jpg')
  writeFileSync(good, 'good'); writeFileSync(bad, 'bad')
  product(snapshot, 'good', pathToFileURL(good).href)
  product(snapshot, 'bad', pathToFileURL(bad).href)
  usingDb(snapshot, db => {
    db.exec('CREATE TABLE backup_assets(original_url TEXT PRIMARY KEY, sha256 TEXT, bytes BLOB, error TEXT)')
    db.exec("CREATE TRIGGER fail_photo BEFORE INSERT ON backup_assets WHEN NEW.original_url LIKE '%/bad.jpg' BEGIN SELECT RAISE(ABORT,'fixture disk write failure'); END")
  })
  await expect(embedBackupPhotos(snapshot, root)).rejects.toThrow('fixture disk write failure')
  expect(usingDb(snapshot, db => db.prepare('SELECT count(*) n FROM backup_assets').get())).toEqual({ n: 0 })
  usingDb(snapshot, db => db.exec('DROP TRIGGER fail_photo'))
  await embedBackupPhotos(snapshot, root)
  expect(usingDb(snapshot, db => db.prepare('SELECT count(*) n FROM backup_assets').get())).toEqual({ n: 2 })
})

it('accepts case-only differences in a legitimate Windows photo URL', async () => {
  const { root, snapshot } = fixture()
  const photo = path.join(root, 'photos', 'good.jpg')
  writeFileSync(photo, 'case-safe')
  const url = pathToFileURL(process.platform === 'win32' ? photo.toUpperCase() : photo).href
  product(snapshot, 'a', url)
  await embedBackupPhotos(snapshot, root)
  expect(asset(snapshot, url)).toMatchObject({ sha256: hash('case-safe'), error: null })
})

it.each(['directory', 'file'])('refuses redirected %s paths during photo restore without changing product links', async kind => {
  const { root, snapshot } = fixture()
  const source = path.join(root, 'photos', 'original.jpg'), bytes = 'original-photo'
  writeFileSync(source, bytes)
  const url = pathToFileURL(source).href
  product(snapshot, 'original', url)
  await embedBackupPhotos(snapshot, root)
  const destination = path.join(root, 'restore'), external = path.join(root, 'external')
  mkdirSync(destination); mkdirSync(external)
  const targetName = 'restored-' + hash(bytes) + '.jpg'
  if (kind === 'directory') {
    symlinkSync(external, path.join(destination, 'photos'), process.platform === 'win32' ? 'junction' : 'dir')
  } else {
    mkdirSync(path.join(destination, 'photos'))
    // A directory junction works without developer-mode symlink privileges on Windows.
    // A non-file target must be rejected, not treated as a previously restored photo.
    symlinkSync(external, path.join(destination, 'photos', targetName), process.platform === 'win32' ? 'junction' : 'dir')
  }
  usingDb(snapshot, db => {
    expect(() => restoreEmbeddedPhotos(db, destination)).toThrow('Неприпустиме сховище відновлення фото')
    expect(db.prepare('SELECT photo_url FROM products WHERE id=?').get('original')).toEqual({ photo_url: url })
    expect(db.prepare('SELECT count(*) n FROM backup_assets').get()).toEqual({ n: 1 })
  })
  expect(existsSync(path.join(external, targetName))).toBe(false)
})

it('does not read or embed a file through a redirected photo root', async () => {
  const { root, snapshot } = fixture()
  const external = path.join(root, 'external')
  mkdirSync(external)
  writeFileSync(path.join(external, 'private.jpg'), 'not a product attachment')
  rmdirSync(path.join(root, 'photos'))
  symlinkSync(external, path.join(root, 'photos'), process.platform === 'win32' ? 'junction' : 'dir')
  const url = pathToFileURL(path.join(root, 'photos', 'private.jpg')).href
  product(snapshot, 'a', url)
  await embedBackupPhotos(snapshot, root)
  expect(asset(snapshot, url)).toMatchObject({ bytes: null, sha256: null, error: expect.any(String) })
})
