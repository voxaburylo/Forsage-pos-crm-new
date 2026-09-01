import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalSyncRepository } from '../src/repositories/syncRepository'
import { MAX_OUTBOX_ATTEMPTS } from '../src/repositories/outboxPolicy'

/** Далеке майбутнє: рядок точно не потрапить у звичайну чергу за часом. */
const BACKOFF_AT = '2099-01-01T00:00:00.000Z'

describe('LocalSyncRepository stuck-operation recovery', () => {
  let root = ''
  let db: LocalDatabase
  let repository: LocalSyncRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-sync-stuck-'))
    db = new LocalDatabase(root)
    repository = new LocalSyncRepository(db)
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  function insertOperation(options: {
    sequence: number
    attempts: number
    status: 'pending' | 'failed'
    operationType?: string
  }): void {
    db.prepare(`
      INSERT INTO sync_outbox(
        sequence, operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, attempts, next_attempt_at, created_at, last_error
      ) VALUES (?, ?, ?, 'device-1', 'sale', ?, ?, '{}', ?, ?, ?, '2026-01-01T00:00:00.000Z', 'boom')
    `).run(
      options.sequence,
      `operation-${options.sequence}`,
      DEFAULT_TENANT_ID,
      `aggregate-${options.sequence}`,
      options.operationType ?? 'sale.created',
      options.status,
      options.attempts,
      BACKOFF_AT,
    )
  }

  it('lists only operations that exhausted their retries', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })
    insertOperation({ sequence: 2, attempts: MAX_OUTBOX_ATTEMPTS - 1, status: 'failed' })
    insertOperation({ sequence: 3, attempts: 0, status: 'pending' })

    const stuck = repository.listStuck()

    expect(stuck).toHaveLength(1)
    expect(stuck[0].sequence).toBe(1)
    expect(stuck[0].operation_type).toBe('sale.created')
    expect(stuck[0].last_error).toBe('boom')
    // Payload навмисно не віддаємо в UI — він може важити сотні кілобайт.
    expect(stuck[0]).not.toHaveProperty('payload')
  })

  it('requeues stuck operations and reports how many moved', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })
    insertOperation({ sequence: 2, attempts: MAX_OUTBOX_ATTEMPTS + 5, status: 'failed' })

    expect(repository.retryStuck()).toEqual({ retried: 2 })
    expect(repository.listStuck()).toHaveLength(0)

    const rows = db.prepare(
      'SELECT status, attempts, next_attempt_at, last_error FROM sync_outbox ORDER BY sequence',
    ).all() as Array<{ status: string; attempts: number; next_attempt_at: string | null; last_error: string | null }>
    for (const row of rows) {
      expect(row.status).toBe('pending')
      expect(row.attempts).toBe(0)
      expect(row.next_attempt_at).toBeNull()
      expect(row.last_error).toBeNull()
    }
  })

  it('never resets operations that are still retrying on their own', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS - 1, status: 'failed' })

    expect(repository.retryStuck()).toEqual({ retried: 0 })

    const row = db.prepare(
      'SELECT status, attempts, next_attempt_at FROM sync_outbox WHERE sequence = 1',
    ).get() as { status: string; attempts: number; next_attempt_at: string | null }
    // Скидання backoff у рядка, який ще ретраїться сам, влаштувало б шторм запитів.
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(MAX_OUTBOX_ATTEMPTS - 1)
    expect(row.next_attempt_at).toBe(BACKOFF_AT)
  })

  it('retries only the selected operation when the user picks one row', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })
    insertOperation({ sequence: 2, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })

    expect(repository.retryStuck([2])).toEqual({ retried: 1 })

    const remaining = repository.listStuck()
    expect(remaining.map((operation) => operation.sequence)).toEqual([1])
  })

  it('ignores an empty selection instead of requeuing everything', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })

    expect(repository.retryStuck([])).toEqual({ retried: 0 })
    expect(repository.listStuck()).toHaveLength(1)
  })

  it('counts exhausted operations as stuck in the health summary', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })
    insertOperation({ sequence: 2, attempts: 2, status: 'failed' })
    insertOperation({ sequence: 3, attempts: 0, status: 'pending' })

    const status = repository.getSyncStatus()

    expect(status.stuck).toBe(1)
    expect(status.retrying).toBe(1)
    expect(status.pending).toBe(1)
    expect(status.total).toBe(3)
  })
})
