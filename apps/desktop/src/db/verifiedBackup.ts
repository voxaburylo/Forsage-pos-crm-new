import { Worker } from 'node:worker_threads'

// Окреме read-only з'єднання: каса може писати під час копіювання.
// quick_check також не блокує головний потік Electron на великій базі.
const BACKUP_WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync, backup } = require('node:sqlite');
(async () => {
  const source = new DatabaseSync(workerData.source, { readOnly: true, timeout: 5000 });
  try { await backup(source, workerData.destination, { rate: 128 }); }
  finally { source.close(); }
  // Змінюємо лише нову тимчасову копію: переносимий backup має бути одним
  // самодостатнім файлом без WAL/SHM. Робоча база залишається в WAL.
  const probe = new DatabaseSync(workerData.destination, { timeout: 5000 });
  try {
    probe.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;');
    const result = probe.prepare('PRAGMA quick_check').get();
    if (result?.quick_check !== 'ok') throw new Error('LOCAL_BACKUP_CORRUPT');
    if (!probe.prepare("SELECT value_json FROM app_meta WHERE key = 'device_id'").get()) {
      throw new Error('LOCAL_BACKUP_NOT_FORSAGE_DATABASE');
    }
    for (const table of ['products', 'sales', 'inventory_sessions', 'supply_invoices', 'sync_outbox']) {
      if (!probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
        throw new Error('LOCAL_BACKUP_MISSING_TABLE: ' + table);
      }
    }
  } finally { probe.close(); }
  parentPort.postMessage({ ok: true });
})().catch(error => { parentPort.postMessage({ error: error.message }); });
`

export function createVerifiedBackup(source: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(BACKUP_WORKER, { eval: true, workerData: { source, destination } })
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
