import path from 'node:path'
import { existsSync } from 'node:fs'
import { Worker, parentPort, workerData } from 'node:worker_threads'
import { LocalDatabase } from '../db/localDatabase'
import { LocalCatalogRepository } from './catalogRepository'
import { CatalogBatchRepository } from './catalogBatchRepository'
type Batch = Parameters<CatalogBatchRepository['apply']>[0]
// The transaction runs off Electron's UI/event-loop thread. SQLite still serializes writes.
export function applyCatalogBatch(dataRoot: string, input: Batch): Promise<any> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'catalogBatchWorker.js'), { workerData: { catalogBatch: true, dataRoot, input } })
    let message: {result?:any;error?:string}|undefined
    const timer = setTimeout(() => { void worker.terminate() }, 180_000)
    worker.on('message', value => { message = value })
    worker.on('error', error => { message = { error: error.message } })
    worker.on('exit', code => {
      clearTimeout(timer)
      if (code !== 0 || !message || message.error) reject(new Error(message?.error || 'Запис перервано. Повторіть ту саму операцію: захист від дублювання збережено.'))
      else resolve(message.result)
    })
  })
}
if (parentPort && workerData?.catalogBatch) {
  let db: LocalDatabase | undefined
  try {
    if (!existsSync(path.join(workerData.dataRoot,'data','forsage.db'))) throw new Error('Робочу базу не знайдено. Порожню базу не створено.')
    db = new LocalDatabase(workerData.dataRoot)
    const result = new CatalogBatchRepository(db,new LocalCatalogRepository(db)).apply(workerData.input)
    parentPort.postMessage({result})
  } catch(error) {parentPort.postMessage({error:error instanceof Error ? error.message : String(error)})}
  finally {db?.close()}
}
