import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalProblemRepository } from '../src/repositories/problemRepository'
import { LocalSyncRepository } from '../src/repositories/syncRepository'
import { MAX_OUTBOX_ATTEMPTS } from '../src/repositories/outboxPolicy'

describe('журнал проблем каси', () => {
  let root = ''
  let db: LocalDatabase
  let problems: LocalProblemRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-problem-log-'))
    db = new LocalDatabase(root)
    problems = new LocalProblemRepository(db)
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('згортає повтори однієї проблеми в один рядок з лічильником', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      problems.record({
        source: 'sync',
        code: 'sync.operation_rejected',
        title: 'Сервер відхилив операцію',
        detail: 'products_brand_id_fkey',
        entity_type: 'product',
        entity_id: 'product-1',
      })
    }

    const list = problems.list()
    expect(list).toHaveLength(1)
    expect(list[0].occurrences).toBe(3)
    expect(list[0].first_seen_at <= list[0].last_seen_at).toBe(true)
  })

  it('веде проблеми різних товарів окремо', () => {
    for (const productId of ['product-1', 'product-2']) {
      problems.record({
        source: 'sync',
        code: 'sync.operation_rejected',
        title: 'Сервер відхилив операцію',
        entity_type: 'product',
        entity_id: productId,
      })
    }
    expect(problems.list()).toHaveLength(2)
  })

  it('після закриття запису той самий збій відкриває новий рядок', () => {
    problems.record({ source: 'print', code: 'print.failed', title: 'Друк не вдався' })
    const [first] = problems.list()
    problems.resolve(first.id)

    expect(problems.list()).toHaveLength(0)
    expect(problems.list({ includeResolved: true })).toHaveLength(1)

    problems.record({ source: 'print', code: 'print.failed', title: 'Друк не вдався' })
    const open = problems.list()
    expect(open).toHaveLength(1)
    expect(open[0].occurrences).toBe(1)
    expect(open[0].id).not.toBe(first.id)
  })

  it('рахує відкриті помилки й попередження окремо', () => {
    problems.record({ source: 'sync', code: 'a', title: 'Помилка', severity: 'error' })
    problems.record({ source: 'sync', code: 'b', title: 'Увага', severity: 'warning' })
    problems.record({ source: 'fiscal', code: 'c', title: 'Помилка ПРРО' })

    const summary = problems.summary()
    expect(summary.errors).toBe(2)
    expect(summary.warnings).toBe(1)
    expect(summary.last_seen_at).not.toBeNull()

    problems.resolveAll()
    expect(problems.summary()).toMatchObject({ errors: 0, warnings: 0, last_seen_at: null })
  })

  it('віддає текст для передачі розробнику', () => {
    problems.record({
      source: 'sync',
      code: 'sync.operation_stuck',
      title: 'Товар не долетів на сервер',
      detail: 'products_brand_id_fkey',
      entity_type: 'product',
      entity_id: 'product-1',
    })
    const text = problems.exportText()
    expect(text).toContain('Товар не долетів на сервер')
    expect(text).toContain('products_brand_id_fkey')
    expect(text).toContain('product-1')
  })
})

describe('синхронізація пише свої відмови в журнал', () => {
  let root = ''
  let db: LocalDatabase
  let sync: LocalSyncRepository
  let problems: LocalProblemRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-problem-sync-'))
    db = new LocalDatabase(root)
    sync = new LocalSyncRepository(db)
    problems = new LocalProblemRepository(db)
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  function insertOperation(sequence: number, attempts: number): string {
    const operationId = `operation-${sequence}`
    db.prepare(`
      INSERT INTO sync_outbox (
        sequence, operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, attempts, created_at
      ) VALUES (?, ?, ?, 'device-1', 'product', 'product-1', 'product.upsert', '{}', 'pending', ?, ?)
    `).run(sequence, operationId, DEFAULT_TENANT_ID, attempts, new Date().toISOString())
    return operationId
  }

  it('відхилена операція лишає попередження, а вичерпані спроби — помилку', () => {
    const operationId = insertOperation(1, 0)
    sync.applyPushResults([{
      sequence: 1,
      operation_id: operationId,
      status: 'failed',
      error: 'insert or update on table "products" violates foreign key constraint "products_brand_id_fkey"',
    }])

    const afterFirst = problems.list()
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0].severity).toBe('warning')
    expect(afterFirst[0].detail).toContain('products_brand_id_fkey')
    expect(afterFirst[0].entity_id).toBe('product-1')

    const stuckId = insertOperation(2, MAX_OUTBOX_ATTEMPTS - 1)
    sync.applyPushResults([{
      sequence: 2,
      operation_id: stuckId,
      status: 'failed',
      error: 'products_brand_id_fkey',
    }])

    const stuck = problems.list().filter((problem) => problem.code === 'sync.operation_stuck')
    expect(stuck).toHaveLength(1)
    expect(stuck[0].severity).toBe('error')
  })

  it('успішна операція нічого в журнал не пише', () => {
    const operationId = insertOperation(3, 0)
    sync.applyPushResults([{ sequence: 3, operation_id: operationId, status: 'synced' }])
    expect(problems.list()).toHaveLength(0)
  })

  it('обрив зв\'язку не вважається проблемою, а відмова сервера — вважається', () => {
    sync.markPullFailed('fetch failed')
    expect(problems.list()).toHaveLength(0)

    sync.markPullFailed('Внутрішня помилка сервера')
    const list = problems.list()
    expect(list).toHaveLength(1)
    expect(list[0].code).toBe('sync.pull_failed')
  })
})
