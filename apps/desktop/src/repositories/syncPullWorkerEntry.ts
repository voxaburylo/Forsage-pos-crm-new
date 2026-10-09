import { parentPort, workerData } from 'node:worker_threads'
import { LocalDatabase } from '../db/localDatabase'
import { ChunkedSyncApplier } from './chunkedSyncApplier'
import type { SyncWorkerRequest } from './syncPullWorker'
import { assertIncomingCopyContract, assertIncomingCopyContinuity } from './incomingCopyContract'

async function run(): Promise<void> {
  if (!parentPort) return
  let db: LocalDatabase | undefined
  let reply: unknown
  try {
    const request = workerData as SyncWorkerRequest
    if (!request || !['pull', 'bootstrap'].includes(request.kind) || !request.identity
      || typeof request.dataRoot !== 'string' || !request.input) throw new Error('LOCAL_SYNC_WORKER_REQUEST_INVALID')
    const contract = assertIncomingCopyContract(request.input, request.kind, request.expectedTenantId)
    db = new LocalDatabase(request.dataRoot, request.identity)
    assertIncomingCopyContinuity(db, contract)
    const applier = new ChunkedSyncApplier(db)
    const result = request.kind === 'pull'
      ? await applier.applyPullChanges(request.input)
      : await applier.importSnapshot(request.input)
    reply = { ok: true, result }
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    try { db?.close() }
    catch (error) { reply = { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }
  parentPort.postMessage(reply)
  parentPort.close()
}
void run()
