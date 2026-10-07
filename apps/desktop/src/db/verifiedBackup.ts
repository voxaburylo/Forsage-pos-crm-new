import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { assertBackupContents } from './backupValidation'
import { LOCAL_MIGRATIONS } from './schema'

// Окреме read-only з'єднання: каса може писати під час копіювання.
// quick_check також не блокує головний потік Electron на великій базі.
const BACKUP_WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync, backup } = require('node:sqlite');
const { createHash } = require('node:crypto');
const assertBackupContents = (${assertBackupContents.toString()});
(async () => {
  const source = new DatabaseSync(workerData.source, { readOnly: true, timeout: 5000 });
  try { await backup(source, workerData.destination, { rate: 128 }); }
  finally { source.close(); }
  // Змінюємо лише нову тимчасову копію: переносимий backup має бути одним
  // самодостатнім файлом без WAL/SHM. Робоча база залишається в WAL.
  const probe = new DatabaseSync(workerData.destination, { timeout: 5000 });
  try {
    probe.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;');
    assertBackupContents(probe, workerData.knownVersions, bytes => createHash('sha256').update(bytes).digest('hex'));
  } finally { probe.close(); }
  parentPort.postMessage({ ok: true });
})().catch(error => { parentPort.postMessage({ error: error.message }); });
`

export function createVerifiedBackup(source: string, destination: string): Promise<void> {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  if (normalize(source) === normalize(destination)) return Promise.reject(new Error('LOCAL_BACKUP_SAME_FILE'))
  try {
    // A junction, symbolic link or hard link must never turn a backup into a
    // write over the authoritative database, even when the paths look different.
    const realSource = realpathSync(source)
    const realDestination = existsSync(destination) ? realpathSync(destination)
      : path.join(realpathSync(path.dirname(path.resolve(destination))), path.basename(destination))
    if (normalize(realSource) === normalize(realDestination)) throw new Error('LOCAL_BACKUP_SAME_FILE')
    if (existsSync(destination)) {
      const from = statSync(source, { bigint: true }), to = statSync(destination, { bigint: true })
      if (from.ino !== 0n && from.ino === to.ino && from.dev === to.dev) throw new Error('LOCAL_BACKUP_SAME_FILE')
    }
  } catch (error) { return Promise.reject(error) }
  return new Promise((resolve, reject) => {
    const worker = new Worker(BACKUP_WORKER, { eval: true,
      workerData: { source, destination, knownVersions: LOCAL_MIGRATIONS.map(migration => migration.version) } })
    let verified = false
    let failure: Error | null = null
    const timeout = setTimeout(() => {
      failure = new Error('LOCAL_BACKUP_TIMEOUT')
      void worker.terminate()
    }, 120_000)
    worker.on('message', (message: { ok?: boolean; error?: string }) => {
      verified = message.ok === true
      if (message.error) failure = new Error(message.error)
    })
    worker.on('error', (error) => { failure = error })
    // Чекаємо закриття всіх дескрипторів перед перейменуванням/прибиранням.
    worker.once('exit', (code) => {
      clearTimeout(timeout)
      if (failure || !verified || code !== 0) reject(failure ?? new Error('LOCAL_BACKUP_INCOMPLETE'))
      else resolve()
    })
  })
}
