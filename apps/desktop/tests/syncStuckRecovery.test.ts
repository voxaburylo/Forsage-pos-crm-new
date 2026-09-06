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
    payload?: unknown
  }): void {
    db.prepare(`
      INSERT INTO sync_outbox(
        sequence, operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, attempts, next_attempt_at, created_at, last_error
      ) VALUES (?, ?, ?, 'device-1', 'sale', ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', 'boom')
    `).run(
      options.sequence,
      `operation-${options.sequence}`,
      DEFAULT_TENANT_ID,
      `aggregate-${options.sequence}`,
      options.operationType ?? 'sale.created',
      JSON.stringify(options.payload ?? {}),
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

  it('на старті каси будить застрягле — одну спробу зараз, не тридцять', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })
    insertOperation({ sequence: 2, attempts: MAX_OUTBOX_ATTEMPTS + 5, status: 'failed' })

    expect(repository.wakeStuckOperations()).toEqual({ woken: 2 })

    const rows = db.prepare(
      'SELECT status, attempts, next_attempt_at FROM sync_outbox ORDER BY sequence',
    ).all() as Array<{ status: string; attempts: number; next_attempt_at: string | null }>
    for (const row of rows) {
      // Час наступної спроби знято — рядок піде вже в найближчому обміні.
      expect(row.next_attempt_at).toBeNull()
      // А лічильник лишився: якщо знову не вийде, повернеться до розкладу раз
      // на шість годин, а не влаштує тридцять марних звернень поспіль.
      expect(row.status).toBe('failed')
      expect(row.attempts).toBeGreaterThanOrEqual(MAX_OUTBOX_ATTEMPTS)
    }
  })

  it('не чіпає те, що ще ретраїться саме', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS - 1, status: 'failed' })

    expect(repository.wakeStuckOperations()).toEqual({ woken: 0 })

    const row = db.prepare(
      'SELECT status, attempts, next_attempt_at FROM sync_outbox WHERE sequence = 1',
    ).get() as { status: string; attempts: number; next_attempt_at: string | null }
    // Скидання пауз у рядка, який ще ретраїться сам, влаштувало б шторм запитів.
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(MAX_OUTBOX_ATTEMPTS - 1)
    expect(row.next_attempt_at).toBe(BACKOFF_AT)
  })

  it('будиться сама, щойно каса відкрила базу', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })

    // Новий репозиторій — це і є старт програми.
    new LocalSyncRepository(db)

    const row = db.prepare('SELECT next_attempt_at FROM sync_outbox WHERE sequence = 1')
      .get() as { next_attempt_at: string | null }
    expect(row.next_attempt_at).toBeNull()
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
