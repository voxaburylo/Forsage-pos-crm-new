import path from 'node:path'
import { Worker, type WorkerOptions } from 'node:worker_threads'
import type { LocalDatabase, ExistingDatabaseIdentity } from '../db/localDatabase'
import { DEFAULT_TENANT_ID, type LocalBootstrapImportResult, type LocalBootstrapSnapshot, type LocalSyncPullChanges, type LocalSyncPullResult } from '../db/localTypes'

export interface LocalSyncPullExecutor {
  applyPullChanges(changes: LocalSyncPullChanges): Promise<LocalSyncPullResult>
  importSnapshot(snapshot: LocalBootstrapSnapshot): Promise<LocalBootstrapImportResult>
}

export type SyncWorkerRequest = {
  dataRoot: string
  identity: ExistingDatabaseIdentity
  expectedTenantId: string
} & ({ kind: 'pull'; input: LocalSyncPullChanges } | { kind: 'bootstrap'; input: LocalBootstrapSnapshot })

type Options = {
  timeoutMs?: number
  /** Trusted application configuration, never taken from the downloaded copy. */
  expectedTenantId?: string
  workerFactory?: (filename: string, options: WorkerOptions) => Worker
}
type Result = LocalSyncPullResult | LocalBootstrapImportResult
const interrupted = 'Копіювання перервано. Перевірте результат і повторіть ту саму операцію.'
const invalidReply = 'Не отримано коректного підтвердження копіювання. Перевірте результат перед повтором.'

type ExpectedReply = { kind: 'pull' | 'bootstrap'; cursor?: string; tenantId?: string }
function isResult(value: unknown, expected: ExpectedReply): value is Result {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  if (!result.counts || typeof result.counts !== 'object' || Array.isArray(result.counts)
    || !Object.values(result.counts).every(count => Number.isSafeInteger(count) && Number(count) >= 0)) return false
  const timestamp = expected.kind === 'pull' ? result.applied_at : result.imported_at
  if (typeof timestamp !== 'string' || !timestamp || !Number.isFinite(Date.parse(timestamp))) return false
  return expected.kind === 'pull'
    ? result.cursor === expected.cursor
    : result.tenant_id === expected.tenantId
}

/** Wait for exit, not only a message: no DB handles may survive success or failure. */
function startWorker(request: SyncWorkerRequest, options: Options): Promise<Result> {
  const expected: ExpectedReply = request.kind === 'pull'
    ? { kind: 'pull', cursor: request.input.cursor } : { kind: 'bootstrap', tenantId: request.input.tenant_id }
  return new Promise((resolve, reject) => {
    // Worker construction clones immediately, before returning control to the caller.
    const worker = (options.workerFactory ?? ((file, opts) => new Worker(file, opts)))(
      path.join(__dirname, 'syncPullWorkerEntry.js'), { workerData: request },
    )
    let reply: Result | undefined
    let failure: Error | undefined
    let received = false
    const timer = setTimeout(() => {
      failure = new Error(interrupted)
      void worker.terminate().catch(error => { failure = error instanceof Error ? error : new Error(interrupted) })
    }, options.timeoutMs ?? 180_000)
    worker.on('message', (message: unknown) => {
      if (received) { failure = new Error(invalidReply); return }
      received = true
      if (!message || typeof message !== 'object') { failure = new Error(invalidReply); return }
      const envelope = message as Record<string, unknown>
      if (envelope.ok === false && typeof envelope.error === 'string' && envelope.error) {
        failure = new Error(envelope.error)
      } else if (envelope.ok === true && isResult(envelope.result, expected)) reply = envelope.result
      else failure = new Error(invalidReply)
    })
    worker.on('error', error => { failure = error })
    worker.once('exit', code => {
      clearTimeout(timer)
      if (failure || code !== 0 || !reply) reject(failure ?? new Error(interrupted))
      else resolve(reply)
    })
  })
}

/** Does not grant incoming-sync permission; the existing authority gate stays in main.ts. */
export function createBackgroundSyncExecutor(db: LocalDatabase, options: Options = {}): LocalSyncPullExecutor {
  const execute = (request: Omit<SyncWorkerRequest, 'dataRoot' | 'identity' | 'expectedTenantId'>): Promise<Result> =>
    db.runBackgroundWrite(() => {
      const info = db.info()
      return startWorker({ ...request, dataRoot: db.dataRoot,
        expectedTenantId: options.expectedTenantId ?? DEFAULT_TENANT_ID,
        identity: { deviceId: info.deviceId, schemaVersion: info.schemaVersion } } as SyncWorkerRequest, options)
    })
  return {
    applyPullChanges: input => execute({ kind: 'pull', input }) as Promise<LocalSyncPullResult>,
    importSnapshot: input => execute({ kind: 'bootstrap', input }) as Promise<LocalBootstrapImportResult>,
  }
}
