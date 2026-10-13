import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker, parentPort, workerData } from 'node:worker_threads'
import type { LocalDatabase } from '../db/localDatabase'
import { CatalogCleanupRepository } from './catalogCleanupRepository'

/** Read-only work on 15k+ cards must not block checkout/main. Mutations never run in this worker. */
export function scanCatalogCleanup(dataRoot: string, tenantId: string): Promise<ReturnType<CatalogCleanupRepository['scan']>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'catalogCleanupWorker.js'), { workerData: { cleanupScan: true, dataRoot, tenantId } })
    let message: { result?: ReturnType<CatalogCleanupRepository['scan']>; error?: string } | undefined
    const timer = setTimeout(() => { message = { error: 'Сканування тривало надто довго. Дані не змінено.' }; void worker.terminate() }, 120_000)
    worker.on('message', value => { message = value })
    worker.on('error', () => { message = { error: 'Сканування перервано. Дані не змінено.' } })
    worker.on('exit', code => { clearTimeout(timer); if (code || !message?.result || message.error) reject(new Error(message?.error ?? 'Сканування перервано')); else resolve(message.result) })
  })
}
if (parentPort && workerData?.cleanupScan) {
  const db = new DatabaseSync(path.join(workerData.dataRoot, 'data', 'forsage.db'), { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON; BEGIN')
    const result = new CatalogCleanupRepository(db as unknown as LocalDatabase).scan(workerData.tenantId)
    db.exec('ROLLBACK'); parentPort.postMessage({ result })
  } catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : 'Не вдалося прочитати каталог' }) }
  finally { db.close() }
}
