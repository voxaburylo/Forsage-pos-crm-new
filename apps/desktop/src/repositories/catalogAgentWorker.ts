import path from 'node:path'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Worker, parentPort, workerData } from 'node:worker_threads'
import { LocalDatabase } from '../db/localDatabase'
import { CatalogAgentRepository } from './catalogAgentRepository'
export function runCatalogAgent(dataRoot: string, mode: 'scan' | 'apply', input: any, userId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'catalogAgentWorker.js'), { workerData: { catalogAgent: true, dataRoot, mode, input, userId } })
    let message: any
    const timeout = setTimeout(() => { message = { error: 'Перевірка тривала занадто довго. Операцію зупинено; для запису повторіть той самий запит.' }; void worker.terminate() }, 180_000)
    worker.on('message', value => { message = value })
    worker.on('error', error => { message = { error: error.message } })
    worker.on('exit', code => { clearTimeout(timeout); if (code || !message || message.error) reject(new Error(message?.error ?? 'AI-агент перерваний')); else resolve(message.result) })
  })
}
if (parentPort && workerData?.catalogAgent) {
  let db: LocalDatabase | DatabaseSync | undefined
  try {
    const file = path.join(workerData.dataRoot, 'data', 'forsage.db')
    if (!existsSync(file)) throw new Error('Робочу базу не знайдено')
    db = workerData.mode === 'scan' ? new DatabaseSync(file, { readOnly: true }) : new LocalDatabase(workerData.dataRoot)
    const agent = new CatalogAgentRepository(db as LocalDatabase)
    if (workerData.mode === 'scan') (db as DatabaseSync).exec('BEGIN')
    const result = workerData.mode === 'scan' ? agent.scan(workerData.input) : agent.apply(workerData.input, workerData.userId)
    if (workerData.mode === 'scan') (db as DatabaseSync).exec('COMMIT')
    parentPort.postMessage({ result })
  } catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
  finally { db?.close() }
}
