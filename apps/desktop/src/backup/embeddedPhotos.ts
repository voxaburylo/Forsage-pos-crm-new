import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

// Only a private snapshot is modified. Gzip remains a normal, restorable SQLite DB.
export async function embedBackupPhotos(snapshot: string, dataRoot: string): Promise<void> {
  if (path.resolve(snapshot) === path.resolve(dataRoot, 'data', 'forsage.db')) throw new Error('Не можна пакувати робочу базу')
  const db = new DatabaseSync(snapshot)
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backup_assets'").get()) return
    const urls = db.prepare("SELECT DISTINCT photo_url FROM products WHERE photo_url LIKE 'file:%'").all() as {photo_url:string}[]
    const root = path.resolve(dataRoot, 'photos')
    db.exec('BEGIN; CREATE TABLE backup_assets(original_url TEXT PRIMARY KEY, sha256 TEXT, bytes BLOB, error TEXT)')
    const insert = db.prepare('INSERT INTO backup_assets VALUES(?,?,?,?)')
    for (const row of urls) {
      const source = path.resolve(fileURLToPath(row.photo_url))
      if (!source.startsWith(root + path.sep)) { insert.run(row.photo_url,null,null,'Фото поза локальним сховищем'); continue }
      try {
        if (!realpathSync(source).startsWith(realpathSync(root) + path.sep)) throw new Error('Неприпустиме посилання')
        const bytes = await readFile(source)
        insert.run(row.photo_url,createHash('sha256').update(bytes).digest('hex'),bytes,null)
      } catch { insert.run(row.photo_url,null,null,'Файл фото відсутній або недоступний') }
    }
    db.exec('COMMIT')
  } catch(error) { if(db.isTransaction)db.exec('ROLLBACK');throw error } finally {db.close()}
}

// Called only when a restored snapshot actually contains embedded attachments.
// New content-addressed filenames never overwrite existing user attachments.
export function restoreEmbeddedPhotos(db: DatabaseSync, dataRoot: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backup_assets'").get()) return
  const rows=db.prepare('SELECT original_url,sha256,bytes FROM backup_assets WHERE bytes IS NOT NULL').iterate() as Iterable<{original_url:string;sha256:string;bytes:Uint8Array}>
  const root=path.join(dataRoot,'photos');mkdirSync(root,{recursive:true})
  db.exec('BEGIN')
  try {
    for(const row of rows) {
      const hash=createHash('sha256').update(row.bytes).digest('hex')
      if(hash!==row.sha256)throw new Error('Контрольна сума фото у копії не збігається')
      const target=path.join(root,'restored-'+hash+'.jpg')
      if(existsSync(target)) { if(createHash('sha256').update(readFileSync(target)).digest('hex')!==hash)throw new Error('Конфлікт відновлення фото') }
      else writeFileSync(target,row.bytes,{flag:'wx'})
      db.prepare('UPDATE products SET photo_url=? WHERE photo_url=?').run(pathToFileURL(target).href,row.original_url)
    }
    db.exec('DROP TABLE backup_assets; COMMIT')
  } catch(error) {db.exec('ROLLBACK');throw error}
}
