import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalSyncRepository } from '../src/repositories/syncRepository'
import { outboxDependencyKeys } from '../src/repositories/outboxDependencies'
let root: string, db: LocalDatabase
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-cleanup-outbox-')); db = new LocalDatabase(root) })
afterEach(() => { db.close(); if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-cleanup-outbox-')) rmSync(root, { recursive: true, force: true }) })
function enqueue(id: string, type: string, payload: object = {}) {
  db.prepare(`INSERT INTO sync_outbox(operation_id,tenant_id,device_id,aggregate_type,aggregate_id,operation_type,payload_json,status,created_at)
    VALUES(?,?,?,'product',?,?,?,'pending',?)`).run(randomUUID(), tenant, db.deviceId, id, type, JSON.stringify(payload), new Date().toISOString())
}
it('does not coalesce away required pre-merge source/target creation snapshots', () => {
  enqueue('source', 'product.upsert', { name: 'old source' }); enqueue('target', 'product.upsert', { name: 'old target' })
  enqueue('target', 'product.catalog_cleanup', { target_id: 'target', source_ids: ['source'] })
  enqueue('target', 'product.upsert', { name: 'edited target' }); enqueue('source', 'product.deleted')
  const before = db.prepare('SELECT * FROM sync_outbox ORDER BY sequence').all()
  ;(new LocalSyncRepository(db) as any).coalesceSupersededProductOperations()
  expect(db.prepare('SELECT * FROM sync_outbox ORDER BY sequence').all()).toEqual(before)
})
it('all sources participate in dependency barriers', () => {
  const keys = outboxDependencyKeys({ tenant_id: tenant, aggregate_type: 'product', aggregate_id: 'target', operation_type: 'product.catalog_cleanup' }, { target_id: 'target', source_ids: ['a', 'b'] })
  for (const id of ['target', 'a', 'b']) expect(keys).toContain(`${tenant}:reference:product:${id}`)
})
