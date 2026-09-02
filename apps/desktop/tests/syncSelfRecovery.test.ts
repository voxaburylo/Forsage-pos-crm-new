import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalSyncRepository } from '../src/repositories/syncRepository'
import { MAX_OUTBOX_ATTEMPTS, STUCK_OUTBOX_RETRY_MS } from '../src/repositories/outboxPolicy'

/**
 * Касир за чергою не стежить і не повинен. Тому черга мусить розбиратися сама:
 * застрягле повертається до спроб, а порядок «спочатку довідник, потім товар»
 * дотримується без ручного втручання.
 */
describe('черга лікується сама', () => {
  let root = ''
  let db: LocalDatabase
  let repository: LocalSyncRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-self-recovery-'))
    db = new LocalDatabase(root)
    repository = new LocalSyncRepository(db)
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  function insert(options: {
    sequence: number
    attempts?: number
    status?: 'pending' | 'failed'
    aggregateType?: string
    aggregateId?: string
    operationType?: string
    payload?: Record<string, unknown>
    nextAttemptAt?: string | null
  }): string {
    const operationId = `operation-${options.sequence}`
    db.prepare(`
      INSERT INTO sync_outbox(
        sequence, operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, attempts, next_attempt_at, created_at, last_error
      ) VALUES (?, ?, ?, 'device-1', ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', 'boom')
    `).run(
      options.sequence,
      operationId,
      DEFAULT_TENANT_ID,
      options.aggregateType ?? 'sale',
      options.aggregateId ?? `aggregate-${options.sequence}`,
      options.operationType ?? 'sale.completed',
      JSON.stringify(options.payload ?? {}),
      options.status ?? 'failed',
      options.attempts ?? 0,
      options.nextAttemptAt === undefined ? null : options.nextAttemptAt,
    )
    return operationId
  }

  it('операція з вичерпаними спробами повертається в чергу, коли настав її час', () => {
    insert({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS, nextAttemptAt: '2020-01-01T00:00:00.000Z' })

    const pending = repository.listPending()

    // Раніше такий рядок випадав з черги назавжди й чекав ручного «Повторити».
    expect(pending.map((operation) => operation.sequence)).toContain(1)
  })

  it('застрягле не молотить сервер: до наступної спроби витримується пауза в години', () => {
    const operationId = insert({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS - 1, nextAttemptAt: null })
    repository.applyPushResults([{ sequence: 1, operation_id: operationId, status: 'failed', error: 'boom' }])

    const row = db.prepare('SELECT attempts, next_attempt_at FROM sync_outbox WHERE sequence = 1')
      .get() as { attempts: number; next_attempt_at: string }
    expect(row.attempts).toBe(MAX_OUTBOX_ATTEMPTS)

    const waitMs = new Date(row.next_attempt_at).getTime() - Date.now()
    expect(waitMs).toBeGreaterThan(STUCK_OUTBOX_RETRY_MS / 2)
    expect(waitMs).toBeLessThanOrEqual(STUCK_OUTBOX_RETRY_MS + 60_000)
  })

  it('товар чекає свій бренд, навіть якщо бренд уже застряг', () => {
    const brandId = '11111111-1111-4111-8111-111111111111'
    insert({
      sequence: 1,
      attempts: MAX_OUTBOX_ATTEMPTS,
      aggregateType: 'brand',
      aggregateId: brandId,
      operationType: 'brand.upsert',
      payload: { id: brandId, name: 'Winso' },
      nextAttemptAt: '2099-01-01T00:00:00.000Z',
    })
    insert({
      sequence: 2,
      status: 'pending',
      aggregateType: 'product',
      aggregateId: '22222222-2222-4222-8222-222222222222',
      operationType: 'product.upsert',
      payload: { id: '22222222-2222-4222-8222-222222222222', brand_id: brandId },
    })

    const pending = repository.listPending()

    // Товар без свого бренда впаде на зовнішньому ключі й потягне за собою
    // прихід та ревізію — саме цей ланцюжок ламав залишки.
    expect(pending.map((operation) => operation.sequence)).not.toContain(2)
  })

  it('чужий продаж не блокується застряглим брендом', () => {
    const brandId = '33333333-3333-4333-8333-333333333333'
    insert({
      sequence: 1,
      attempts: MAX_OUTBOX_ATTEMPTS,
      aggregateType: 'brand',
      aggregateId: brandId,
      operationType: 'brand.upsert',
      payload: { id: brandId, name: 'Elegant' },
      nextAttemptAt: '2099-01-01T00:00:00.000Z',
    })
    insert({ sequence: 2, status: 'pending', payload: { sale_id: 'sale-1' } })

    expect(repository.listPending().map((operation) => operation.sequence)).toContain(2)
  })
})
