import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { createBackgroundSyncExecutor } from '../src/repositories/syncPullWorker'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

let db: LocalDatabase, root: string
const at = '2026-10-09T10:00:00.000Z'
const success = () => ({ ok: true, result: { cursor: at, applied_at: at, counts: {} } })
const timeout = () => Number((db.prepare('PRAGMA busy_timeout').get() as any).timeout)
class FakeWorker extends EventEmitter {
  terminate = vi.fn(async () => { setImmediate(() => this.emit('exit', 1)); return 1 })
}
const harness = (timeoutMs = 5000) => {
  const worker = new FakeWorker()
  const factory = vi.fn(() => worker as unknown as Worker)
  return { worker, factory, executor: createBackgroundSyncExecutor(db, { timeoutMs, workerFactory: factory }) }
}
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'forsage-sync-worker-test-'))
  db = new LocalDatabase(root)
})
afterEach(async () => {
  vi.useRealTimers()
  await db.waitForBackgroundWrite().catch(() => {})
  db.close()
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('forsage-sync-worker-test-')) {
    rmSync(root, { recursive: true, force: true })
  }
})
it('attaches to the same identity without migration or recovery writes', () => {
  const before = db.prepare('SELECT * FROM app_meta ORDER BY key').all()
  const attached = new LocalDatabase(root, db.info())
  expect(attached.info().deviceId).toBe(db.deviceId)
  attached.close()
  expect(db.prepare('SELECT * FROM app_meta ORDER BY key').all()).toEqual(before)
})
it.each(['identity', 'version'])('rejects mismatching %s instead of migrating or generating identity', kind => {
  const info = db.info()
  expect(() => new LocalDatabase(root, { deviceId: kind === 'identity' ? 'wrong' : info.deviceId,
    schemaVersion: kind === 'version' ? info.schemaVersion - 1 : info.schemaVersion })).toThrow('IDENTITY_MISMATCH')
  expect(db.info()).toEqual(info)
})
it('does not create a missing worker database or folders', () => {
  const missing = path.join(root, 'missing')
  expect(() => new LocalDatabase(missing, db.info())).toThrow('Порожню базу не створено')
  expect(existsSync(missing)).toBe(false)
})
it('waits for exit before success, restores timeout and protects close', async () => {
  db.exec('PRAGMA busy_timeout=1234')
  const { worker, executor } = harness()
  const pending = executor.applyPullChanges({ cursor: at })
  let done = false
  void pending.then(() => { done = true })
  expect(timeout()).toBe(0)
  expect(() => db.close()).toThrow('Копіювання ще триває')
  worker.emit('message', success())
  await Promise.resolve()
  expect(done).toBe(false)
  worker.emit('exit', 0)
  await expect(pending).resolves.toEqual(success().result)
  await db.waitForBackgroundWrite()
  expect(timeout()).toBe(1234)
})
it('refuses a second copy instead of reusing a different result', async () => {
  const { worker, executor, factory } = harness()
  const pending = executor.applyPullChanges({ cursor: at })
  await expect(executor.applyPullChanges({ cursor: 'other' })).rejects.toThrow('Копіювання вже триває')
  expect(factory).toHaveBeenCalledTimes(1)
  worker.emit('message', success()); worker.emit('exit', 0)
  await pending
})
it('snapshot identifiers cannot be changed by caller during the worker operation', async () => {
  const { worker, executor } = harness()
  const input = { cursor: at }
  const pending = executor.applyPullChanges(input)
  input.cursor = 'mutated'
  worker.emit('message', success()); worker.emit('exit', 0)
  await expect(pending).resolves.toMatchObject({ cursor: at })
})
it.each([
  undefined, {}, { ok: true, result: {} },
  { ok: true, result: { ...success().result, cursor: 'wrong' } },
  { ok: true, result: { ...success().result, applied_at: 'bad' } },
  { ok: true, result: { ...success().result, counts: [] } },
  { ok: true, result: { ...success().result, counts: { products: -1 } } },
  { ok: true, result: { ...success().result, counts: { products: NaN } } },
  { ok: true, result: { ...success().result, counts: { products: 1.5 } } },
  { ok: true, result: { ...success().result, counts: { products: '1' } } },
])('rejects malformed replies %#', async reply => {
  const { worker, executor } = harness()
  const pending = executor.applyPullChanges({ cursor: at })
  worker.emit('message', reply); worker.emit('exit', 0)
  await expect(pending).rejects.toThrow('коректного підтвердження')
  expect(timeout()).toBe(5000)
})
it.each(['no-message', 'exit-error', 'worker-error', 'duplicate', 'rejected'])('fails safely on %s', async fault => {
  const { worker, executor } = harness()
  const pending = executor.applyPullChanges({ cursor: at })
  if (fault !== 'no-message') worker.emit('message', fault === 'rejected' ? { ok: false, error: 'fixture failure' } : success())
  if (fault === 'duplicate') worker.emit('message', success())
  if (fault === 'worker-error') worker.emit('error', new Error('fixture error'))
  worker.emit('exit', fault === 'exit-error' ? 1 : 0)
  await expect(pending).rejects.toThrow()
  expect(timeout()).toBe(5000)
})
it('terminates on timeout and waits for the exit event', async () => {
  const { worker, executor } = harness(10)
  const pending = executor.applyPullChanges({ cursor: at })
  await expect(pending).rejects.toThrow('Копіювання перервано')
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(timeout()).toBe(5000)
})
it('restores timeout when worker construction fails', async () => {
  const executor = createBackgroundSyncExecutor(db, { workerFactory: () => { throw new Error('start failed') } })
  await expect(executor.applyPullChanges({ cursor: at })).rejects.toThrow('start failed')
  expect(timeout()).toBe(5000)
})
it('refuses starting a worker within a synchronous transaction', async () => {
  let pending: Promise<unknown> | undefined
  db.transaction(() => { pending = createBackgroundSyncExecutor(db).applyPullChanges({ cursor: at }) })
  await expect(pending).rejects.toThrow('LOCAL_ASYNC_TRANSACTION_FORBIDDEN')
})
it('rejects on a closed database', async () => {
  db.close()
  await expect(createBackgroundSyncExecutor(db).applyPullChanges({ cursor: at })).rejects.toThrow('LOCAL_DATABASE_NOT_READY')
})
it('forwards both repository async paths to the executor', async () => {
  const executor = { applyPullChanges: vi.fn(async () => success().result),
    importSnapshot: vi.fn(async () => ({ imported_at: at, tenant_id: 'tenant', counts: {} })) }
  const sync = new LocalSyncRepository(db, undefined, executor as any)
  await sync.applyPullChangesChunked({ cursor: at })
  await sync.importSnapshotChunked({ exported_at: at, tenant_id: 'tenant' })
  expect(executor.applyPullChanges).toHaveBeenCalledWith({ cursor: at })
  expect(executor.importSnapshot).toHaveBeenCalledWith({ exported_at: at, tenant_id: 'tenant' })
})
it('accepts bootstrap reply only for the requested tenant', async () => {
  const { worker, executor } = harness()
  const pending = executor.importSnapshot({ exported_at: at, tenant_id: 'tenant' })
  worker.emit('message', { ok: true, result: { imported_at: at, tenant_id: 'other', counts: {} } })
  worker.emit('exit', 0)
  await expect(pending).rejects.toThrow()
})
