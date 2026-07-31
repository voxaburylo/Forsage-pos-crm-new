import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'

describe('local sync queue recovery migration', () => {
  let root = ''
  let db: LocalDatabase | null = null

  afterEach(() => {
    db?.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-queue-recovery-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips only legacy inventories without expected stock and retries the return', () => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-queue-recovery-'))
    db = new LocalDatabase(root)

    const insert = (operationType: string, payload: unknown, status: 'pending' | 'failed', error: string | null) => {
      const operationId = randomUUID()
      db!.prepare(`
        INSERT INTO sync_outbox (
          operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
          operation_type, payload_json, status, attempts, next_attempt_at, created_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        operationId,
        DEFAULT_TENANT_ID,
        db!.deviceId,
        operationType === 'return.created' ? 'return' : 'inventory',
        randomUUID(),
        operationType,
        JSON.stringify(payload),
        status,
        status === 'failed' ? 1 : 0,
        new Date().toISOString(),
        error,
      )
      return operationId
    }

    const legacy = insert('inventory.completed', { items: [{ product_id: randomUUID(), counted_stock: 3 }] }, 'pending', null)
    const current = insert('inventory.completed', { items: [{ product_id: randomUUID(), expected_stock: 5, counted_stock: 3 }] }, 'pending', null)
    const returned = insert('return.created', { id: randomUUID() }, 'failed', 'Не вдалося сторнувати комісію повернення')

    db.prepare('DELETE FROM schema_migrations WHERE version = 21').run()
    db.close()
    db = new LocalDatabase(root)

    const rows = db.prepare(`
      SELECT operation_id, status, attempts, last_error
      FROM sync_outbox
      WHERE operation_id IN (?, ?, ?)
    `).all(legacy, current, returned) as Array<{
      operation_id: string
      status: string
      attempts: number
      last_error: string | null
    }>
    const byId = new Map(rows.map((row) => [row.operation_id, row]))

    expect(byId.get(legacy)).toMatchObject({ status: 'synced' })
    expect(byId.get(legacy)?.last_error).toContain('Застарілу ревізію')
    expect(byId.get(current)).toMatchObject({ status: 'pending', attempts: 0, last_error: null })
    expect(byId.get(returned)).toMatchObject({ status: 'pending', attempts: 0, last_error: null })
  })
})
