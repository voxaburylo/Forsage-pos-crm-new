import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalSyncRepository } from '../src/repositories/syncRepository'
import { MAX_OUTBOX_ATTEMPTS } from '../src/repositories/outboxPolicy'

/**
 * Власник не має розбирати чергу руками: «я не бачив, щоб так працювало 1С».
 * Застаріла ревізія — не вибір, а правило: сервер не прийме її ніколи, а каса
 * є джерелом правди для залишків. Тому каса знімає її сама й надсилає свою
 * кількість.
 */
describe('застаріла ревізія лікується без участі власника', () => {
  let root = ''
  let db: LocalDatabase
  const productId = '22222222-2222-4222-8222-222222222222'

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-auto-'))
    db = new LocalDatabase(root)
    db.prepare(`
      INSERT INTO products(id, tenant_id, sku, name, qty_on_hand, created_at, updated_at)
      VALUES (?, ?, 'SKU-9', 'Товар для тесту', 6, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run(productId, DEFAULT_TENANT_ID)
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  function queueOperation(options: {
    sequence: number
    operationType: string
    aggregateType: string
    status: 'pending' | 'failed'
    attempts: number
    error?: string | null
  }): string {
    const operationId = randomUUID()
    db.prepare(`
      INSERT INTO sync_outbox(
        sequence, operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, attempts, created_at, last_error
      ) VALUES (?, ?, ?, 'device-1', ?, ?, ?, ?, ?, ?, '2026-09-03T09:43:00.000Z', ?)
    `).run(
      options.sequence, operationId, DEFAULT_TENANT_ID, options.aggregateType, randomUUID(),
      options.operationType,
      JSON.stringify({ items: [{ product_id: productId, counted_stock: 6, expected_stock: 6 }] }),
      options.status, options.attempts, options.error ?? null,
    )
    return operationId
  }

  const staleError = 'Залишок товару змінився після початку ревізії: було 6, зараз 0. Оновіть ревізію.'

  /** Будь-яка відповідь сервера запускає розбір черги. */
  function pushCycle(sync: LocalSyncRepository): void {
    sync.applyPushResults([])
  }

  it('знімає застарілу ревізію з черги і ставить виправлення залишку', () => {
    queueOperation({
      sequence: 100, operationType: 'inventory.completed', aggregateType: 'inventory',
      status: 'failed', attempts: MAX_OUTBOX_ATTEMPTS, error: staleError,
    })
    const sync = new LocalSyncRepository(db)

    pushCycle(sync)

    expect(sync.listStuck()).toHaveLength(0)
    const correction = db.prepare(`
      SELECT status, payload_json FROM sync_outbox
      WHERE operation_type = 'product.upsert' AND aggregate_id = ?
    `).get(productId) as { status: string; payload_json: string } | undefined
    expect(correction?.status).toBe('pending')
    expect(JSON.parse(correction!.payload_json)).toMatchObject({ qty_on_hand: 6, stock_correction: true })

    // Слід лишається: документа на сервері не буде, і це має бути видно.
    const problem = db.prepare(`
      SELECT title, detail FROM problem_log WHERE code = 'sync.operation_discarded'
    `).get() as { title: string; detail: string }
    expect(problem.title).toContain('Застарілу ревізію знято з черги')
    expect(problem.detail).toContain('рахувати наново не треба')
  })

  it('чекає, поки вичерпаються спроби: конфлікт буває тимчасовим', () => {
    queueOperation({
      sequence: 100, operationType: 'inventory.completed', aggregateType: 'inventory',
      status: 'failed', attempts: MAX_OUTBOX_ATTEMPTS - 1, error: staleError,
    })
    const sync = new LocalSyncRepository(db)

    pushCycle(sync)

    const row = db.prepare('SELECT status FROM sync_outbox WHERE sequence = 100').get() as { status: string }
    expect(row.status).toBe('failed')
  })

  it('не чіпає ревізію, поки по тому самому товару щось стоїть у черзі', () => {
    queueOperation({
      sequence: 100, operationType: 'inventory.completed', aggregateType: 'inventory',
      status: 'failed', attempts: MAX_OUTBOX_ATTEMPTS, error: staleError,
    })
    // Попереду ще не доїхав продаж — саме він і міняє залишок на сервері,
    // тому конфлікт може зникнути сам.
    queueOperation({
      sequence: 101, operationType: 'sale.completed', aggregateType: 'sale',
      status: 'pending', attempts: 0,
    })
    const sync = new LocalSyncRepository(db)

    pushCycle(sync)

    const row = db.prepare('SELECT status FROM sync_outbox WHERE sequence = 100').get() as { status: string }
    expect(row.status).toBe('failed')
    expect(db.prepare("SELECT COUNT(*) n FROM sync_outbox WHERE operation_type = 'product.upsert'").get())
      .toEqual({ n: 0 })
  })

  it('не чіпає ревізію, яку сервер відхилив з іншої причини', () => {
    queueOperation({
      sequence: 100, operationType: 'inventory.completed', aggregateType: 'inventory',
      status: 'failed', attempts: MAX_OUTBOX_ATTEMPTS,
      error: 'Недостатньо прав для цієї операції синхронізації',
    })
    const sync = new LocalSyncRepository(db)

    pushCycle(sync)

    // Права можуть виправити на сервері — така операція ще пройде.
    const row = db.prepare('SELECT status FROM sync_outbox WHERE sequence = 100').get() as { status: string }
    expect(row.status).toBe('failed')
  })
})
