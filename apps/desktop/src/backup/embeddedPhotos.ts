import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, statSync, lstatSync, openSync, closeSync, fsyncSync, linkSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const pathKey = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)

// Check before opening for writes: spelling, junctions and hard links may point
// at the same authoritative file. Missing snapshots must not become empty DBs.
function assertPrivateSnapshot(snapshot: string, dataRoot: string): void {
  const live = path.join(dataRoot, 'data', 'forsage.db')
  if (pathKey(snapshot) === pathKey(live)) throw new Error('Не можна пакувати робочу базу')
  const copy = statSync(snapshot, { bigint: true })
  if (!copy.isFile()) throw new Error('Резервна копія має бути файлом')
  if (existsSync(live)) {
    const original = statSync(live, { bigint: true })
    if (pathKey(realpathSync(snapshot)) === pathKey(realpathSync(live))
      || (original.ino !== 0n && original.ino === copy.ino && original.dev === copy.dev)) {
      throw new Error('Не можна пакувати робочу базу')
    }
  }
}

// Only a private snapshot is modified. Existing successful attachments are
// immutable; retries may fill missing ones, never recapture changed originals.
export async function embedBackupPhotos(snapshot: string, dataRoot: string): Promise<void> {
  assertPrivateSnapshot(snapshot, dataRoot)
  const db = new DatabaseSync(snapshot)
  try {
    const urls = db.prepare("SELECT DISTINCT photo_url FROM products WHERE photo_url LIKE 'file:%'").all() as { photo_url: string }[]
    const root = path.join(realpathSync(dataRoot), 'photos')
    db.exec('BEGIN; CREATE TABLE IF NOT EXISTS backup_assets(original_url TEXT PRIMARY KEY, sha256 TEXT, bytes BLOB, error TEXT)')
    const captured = db.prepare('SELECT 1 FROM backup_assets WHERE original_url=? AND bytes IS NOT NULL')
    const insert = db.prepare(`INSERT INTO backup_assets VALUES(?,?,?,?)
      ON CONFLICT(original_url) DO UPDATE SET sha256=excluded.sha256, bytes=excluded.bytes, error=excluded.error
      WHERE backup_assets.bytes IS NULL`)
    for (const row of urls) {
      if (captured.get(row.photo_url)) continue
      let bytes: Buffer | null = null, failure: string | null = null
      try {
        // fileURLToPath can itself fail. One invalid attachment must not abort
        // the database/customer/product export or expose its full URL in errors.
        const source = path.resolve(fileURLToPath(row.photo_url))
        if (!pathKey(source).startsWith(pathKey(root) + path.sep)
          || pathKey(realpathSync(root)) !== pathKey(root)
          || !pathKey(realpathSync(source)).startsWith(pathKey(root) + path.sep)) {
          failure = 'Фото поза локальним сховищем'
        } else if (!statSync(source).isFile()) {
          failure = 'Файл фото відсутній або недоступний'
        } else bytes = await readFile(source)
      } catch { failure = 'Файл фото відсутній або недоступний' }
      // Keep SQL errors outside the per-file catch so disk-full/schema errors
      // roll back the whole asset transaction instead of looking like a bad photo.
      insert.run(row.photo_url, bytes ? createHash('sha256').update(bytes).digest('hex') : null, bytes, failure)
    }
    db.exec('COMMIT')
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error } finally { db.close() }
}

function verifiedPhotoExists(target: string, hash: string): boolean {
  const existing = lstatSync(target, { throwIfNoEntry: false })
  if (!existing) return false
  if (!existing.isFile() || existing.isSymbolicLink())
    throw new Error('Неприпустиме сховище відновлення фото')
  if (createHash('sha256').update(readFileSync(target)).digest('hex') !== hash)
    throw new Error('Конфлікт відновлення фото')
  return true
}

// Never write partial bytes under a final content-addressed name. A hard link
// publishes only complete, flushed bytes and, unlike rename, cannot overwrite
// a target created concurrently. Unsupported filesystems fail before DB changes.
function publishRestoredPhoto(root: string, bytes: Uint8Array, hash: string): string {
  const target = path.join(root, 'restored-' + hash + '.jpg')
  if (verifiedPhotoExists(target, hash)) return target
  const staged = path.join(root, '.restore-photo-' + randomUUID() + '.partial')
  let descriptor: number | undefined
  let owned = false
  try {
    descriptor = openSync(staged, 'wx')
    owned = true
    writeFileSync(descriptor, bytes)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    try {
      linkSync(staged, target)
    } catch (error) {
      // A concurrent restore may already have published the same photo.
      // Never replace a conflicting file, directory, or redirected path.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !verifiedPhotoExists(target, hash)) throw error
    }
    return target
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (owned) {
      // A failed cleanup leaves an unreferenced private staging file, not a
      // broken final photo. Do not turn a completed publication into a failure.
      try { unlinkSync(staged) } catch { /* retry uses a fresh exclusive path */ }
    }
  }
}

// Called only when a restored snapshot actually contains embedded attachments.
// New content-addressed filenames never overwrite existing user attachments.
export function restoreEmbeddedPhotos(db: DatabaseSync, dataRoot: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backup_assets'").get()) return
  if (!db.prepare('SELECT 1 FROM backup_assets WHERE bytes IS NOT NULL LIMIT 1').get()) {
    // Missing-photo records contain no files to restore; preserve their original
    // product links without requiring a writable or even existing photo folder.
    db.exec('DROP TABLE backup_assets')
    return
  }
  const rows=db.prepare('SELECT original_url,sha256,bytes FROM backup_assets WHERE bytes IS NOT NULL').iterate() as Iterable<{original_url:string;sha256:string;bytes:Uint8Array}>
  mkdirSync(dataRoot, { recursive: true })
  const root = path.join(realpathSync(dataRoot), 'photos')
  mkdirSync(root, { recursive: true })
  if (pathKey(realpathSync(root)) !== pathKey(root)) throw new Error('Неприпустиме сховище відновлення фото')
  db.exec('BEGIN')
  try {
    for(const row of rows) {
      const hash=createHash('sha256').update(row.bytes).digest('hex')
      if(hash!==row.sha256)throw new Error('Контрольна сума фото у копії не збігається')
      const target = publishRestoredPhoto(root, row.bytes, hash)
      db.prepare('UPDATE products SET photo_url=? WHERE photo_url=?').run(pathToFileURL(target).href,row.original_url)
    }
    db.exec('DROP TABLE backup_assets; COMMIT')
  } catch(error) {db.exec('ROLLBACK');throw error}
}
