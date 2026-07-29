import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalInventoryRepository } from '../src/repositories/inventoryRepository'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

describe('local inventory synchronization safety', () => {
  let root = ''
  let db: LocalDatabase
  let inventory: LocalInventoryRepository
  let sync: LocalSyncRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-inventory-sync-'))
    db = new LocalDatabase(root)
    inventory = new LocalInventoryRepository(db)
    sync = new LocalSyncRepository(db)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-inventory-sync-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('queues create, start, and empty-session deletion in lifecycle order', () => {
    const userId = randomUUID()
    const session = inventory.createSession({ name: 'Тестова ревізія', created_by: userId })
    inventory.startSession(session.id, { user_id: userId })
    inventory.deleteEmptySession(session.id)

    const operations = sync.listPending(20)
      .filter((item) => item.aggregate_id === session.id)
      .map((item) => item.operation_type)
    expect(operations).toEqual(['inventory.created', 'inventory.started', 'inventory.deleted'])
    expect(inventory.listSessions()).toEqual([])
  })

  it('rejects completing an empty inventory session', () => {
    const userId = randomUUID()
    const session = inventory.createSession({ name: 'Порожня ревізія', created_by: userId })
    inventory.startSession(session.id, { user_id: userId })

    expect(() => inventory.complete(session.id, { user_id: userId })).toThrow('Неможливо завершити порожню ревізію')
    expect(inventory.getSessionData(session.id).status).toBe('in_progress')
  })
  it('removes a remotely deleted session and stale local lifecycle operations', () => {
    const sessionId = randomUUID()
    const userId = randomUUID()
    sync.applyPullChanges({
      cursor: '2026-07-29T11:00:00.000Z',
      inventory_sessions: [{
        id: sessionId,
        tenant_id: DEFAULT_TENANT_ID,
        name: 'Веб-ревізія',
        status: 'draft',
        created_by: userId,
        created_at: '2026-07-29T10:59:00.000Z',
      }],
    })
    inventory.startSession(sessionId, { user_id: userId })
    expect(inventory.listSessions().map((item) => item.id)).toContain(sessionId)

    const result = sync.applyPullChanges({
      cursor: '2026-07-29T11:00:01.000Z',
      deleted_inventory_session_ids: [sessionId],
    })

    expect(result.counts.deleted_inventory_sessions).toBe(1)
    expect(inventory.listSessions().map((item) => item.id)).not.toContain(sessionId)
    expect(sync.listPending(20).some((item) => item.aggregate_id === sessionId)).toBe(false)
  })
})