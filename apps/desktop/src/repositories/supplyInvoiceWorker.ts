import path from 'node:path'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Worker, parentPort, workerData } from 'node:worker_threads'
import { LocalDatabase } from '../db/localDatabase'
import { LocalSupplyRepository } from './supplyRepository'
import { commitReceiving, type ReceivingCommitInput } from './receivingCommit'
import { enableAiInvoiceMatcherCache, previewAiInvoiceRows } from './aiInvoiceIdentity'
import { DEFAULT_TENANT_ID } from '../db/localTypes'

type Input = Parameters<LocalSupplyRepository['createInvoiceFromAiRows']>[0]
type Result = ReturnType<LocalSupplyRepository['createInvoiceFromAiRows']>
type PreviewInput = Parameters<LocalSupplyRepository['previewInvoiceFromAiRows']>[0]
const active = new Map<string, Promise<any>>()
const queued = new Map<string, number>()

/** No UI-thread catalog scanning; the receipt and all draft writes remain atomic. */
export function createAiInvoiceInWorker(dataRoot: string, input: Input): Promise<Result> {
  return runSupplyWorker(dataRoot, input, 'ai')
}

/** Catalog matching is read-only and never blocks Electron's main event loop. */
export function previewAiInvoiceInWorker(dataRoot: string, input: PreviewInput): Promise<ReturnType<LocalSupplyRepository['previewInvoiceFromAiRows']>> {
  return runSupplyWorker(dataRoot, input, 'preview')
}

export function commitReceivingInWorker(dataRoot: string, input: ReceivingCommitInput): Promise<any> {
  return runSupplyWorker(dataRoot, input, 'receiving')
}

function runSupplyWorker(dataRoot: string, input: Input | ReceivingCommitInput | PreviewInput, operation: 'ai' | 'receiving' | 'preview'): Promise<any> {
  if (operation !== 'preview' && (!('operation_id' in input) || !input.operation_id)) return Promise.reject(new Error('Відсутній код операції. Відкрийте розпізнану накладну ще раз.'))
  const count = queued.get(dataRoot) ?? 0
  if (count >= 20) return Promise.reject(new Error('Забагато операцій приймання. Дочекайтеся попереднього запису та повторіть.'))
  queued.set(dataRoot, count + 1)
  // Serialize worker writers. Do not return another input's result for the same operation ID:
  // idempotentMutation validates the complete payload inside the transaction.
  const previous = active.get(dataRoot)
  const task = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => operation === 'preview'
    ? previewInServer(dataRoot, input as PreviewInput)
    : new Promise<Result>((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'supplyInvoiceWorker.js'), { workerData: { aiInvoice: true, operation, dataRoot, input } })
    let reply: { result?: Result; error?: string } | undefined
    const timer = setTimeout(() => { void worker.terminate() }, 180_000)
    worker.on('message', value => { reply = value })
    worker.on('error', error => { reply = { error: error.message } })
    worker.on('exit', code => {
      clearTimeout(timer)
      if (code !== 0 || !reply?.result || reply.error) reject(new Error(reply?.error || 'Створення перервано. Повторіть ту саму операцію — дубль накладної не буде створено.'))
      else resolve(reply.result)
    })
  }))
  active.set(dataRoot, task)
  void task.finally(() => {
    if (active.get(dataRoot) === task) active.delete(dataRoot)
    const remaining = (queued.get(dataRoot) ?? 1) - 1
    if (remaining > 0) queued.set(dataRoot, remaining); else queued.delete(dataRoot)
  }).catch(() => {})
  return task
}

/** Постійний процес перевірки накладної: тримає довідник збігів у пам'яті між правками рядків. */
const previewServers = new Map<string, { worker: Worker; pending: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> }>()
let previewRequest = 0
function previewInServer(dataRoot: string, input: PreviewInput): Promise<any> {
  let server = previewServers.get(dataRoot)
  if (!server) {
    const worker = new Worker(path.join(__dirname, 'supplyInvoiceWorker.js'), { workerData: { aiInvoice: true, operation: 'previewServer', dataRoot } })
    const created = { worker, pending: new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>() }
    const fail = (message: string) => {
      if (previewServers.get(dataRoot) === created) previewServers.delete(dataRoot)
      for (const entry of created.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)) }
      created.pending.clear()
    }
    worker.on('message', (reply: { id: number; result?: unknown; error?: string }) => {
      const entry = created.pending.get(reply.id)
      if (!entry) return
      created.pending.delete(reply.id); clearTimeout(entry.timer)
      if (reply.error) entry.reject(new Error(reply.error)); else entry.resolve(reply.result)
    })
    worker.on('error', error => fail(error.message))
    worker.on('exit', () => fail('Перевірку накладної перервано. Повторіть — накладну не змінено.'))
    worker.unref()
    previewServers.set(dataRoot, created)
    server = created
  }
  const id = ++previewRequest
  const target = server
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.pending.delete(id)
      reject(new Error('Перевірка накладної триває надто довго. Повторіть.'))
      void target.worker.terminate()
    }, 180_000)
    target.pending.set(id, { resolve, reject, timer })
    target.worker.postMessage({ id, input })
  })
}

function previewRowsFromDisk(dataRoot: string, input: any) {
  const rows = input?.rows
  if (!Array.isArray(rows) || !rows.length || rows.length > 2000) throw new Error('Перевірте таблицю товарів (до 2000 рядків).')
  if (!existsSync(path.join(dataRoot, 'data', 'forsage.db'))) throw new Error('Робочу базу не знайдено. Порожню базу не створено.')
  const reader = new DatabaseSync(path.join(dataRoot, 'data', 'forsage.db'), { readOnly: true, timeout: 5000 })
  try {
    reader.exec('BEGIN')
    return previewAiInvoiceRows(reader, input.tenant_id ?? DEFAULT_TENANT_ID, rows, input.operation_id)
  } finally { reader.close() }
}

if (parentPort && workerData?.aiInvoice && workerData.operation === 'previewServer') {
  enableAiInvoiceMatcherCache()
  const port = parentPort
  port.on('message', (message: { id: number; input: any }) => {
    try { port.postMessage({ id: message.id, result: previewRowsFromDisk(workerData.dataRoot, message.input) }) }
    catch (error) { port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) }) }
  })
} else if (parentPort && workerData?.aiInvoice) {
  let db: LocalDatabase | undefined
  try {
    if (!existsSync(path.join(workerData.dataRoot, 'data', 'forsage.db'))) throw new Error('Робочу базу не знайдено. Порожню базу не створено.')
    if (workerData.operation === 'preview') {
      const rows = workerData.input?.rows
      if (!Array.isArray(rows) || !rows.length || rows.length > 2000) throw new Error('Перевірте таблицю товарів (до 2000 рядків).')
      const reader = new DatabaseSync(path.join(workerData.dataRoot, 'data', 'forsage.db'), { readOnly: true, timeout: 5000 })
      try {
        reader.exec('BEGIN')
        parentPort.postMessage({ result: previewAiInvoiceRows(reader, workerData.input.tenant_id ?? DEFAULT_TENANT_ID, rows, workerData.input.operation_id) })
      } finally { reader.close() }
    } else {
      db = new LocalDatabase(workerData.dataRoot)
      const result = workerData.operation === 'receiving' ? commitReceiving(db, workerData.input)
        : new LocalSupplyRepository(db).createInvoiceFromAiRows(workerData.input)
      parentPort.postMessage({ result })
    }
  } catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
  finally { db?.close() }
}
