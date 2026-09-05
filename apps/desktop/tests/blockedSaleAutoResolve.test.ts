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
 * Чек пробитий, товар зі складу пішов, гроші в касі — а сервер не пускає
 * продаж, бо не знає про якийсь прихід і думає, що товару менше. Викинути такий
 * чек означає втратити виторг, лишити в черзі — тримати все наступне по цих
 * товарах. Каса має розв'язати це сама.
 */
describe('продаж, заблокований відʼємним залишком, лікується сам', () => {
  let root = ''
  let db: LocalDatabase
  const productId = '33333333-3333-4333-8333-333333333333'

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-blocked-'))
    db = new LocalDatabase(root)
    db.prepare(`
      INSERT INTO products(id, tenant_id, sku, name, qty_on_hand, created_at, updated_at)
      VALUES (?, ?, 'SKU-5', 'Олива Norvego 10W40', 3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run(productId, DEFAULT_TENANT_ID)
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  const blockedError = 'NEGATIVE_STOCK_BLOCKED: Заборонено відʼємний залишок для товару «Олива Norvego 10W40»'

  function queueSale(options: { sequence: number; qty: number; attempts: number; error?: string }): void {
    db.prepare(`
      INSERT INTO sync_outbox(
        sequence, operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, attempts, created_at, last_error
      ) VALUES (?, ?, ?, 'device-1', 'sale', ?, 'sale.completed', ?, 'failed', ?,
                '2026-09-03T10:38:00.000Z', ?)
    `).run(
      options.sequence, randomUUID(), DEFAULT_TENANT_ID, randomUUID(),
      JSON.stringify({ items: [{ product_id: productId, qty: options.qty }] }),
      options.attempts, options.error ?? blockedError,
    )
  }

  const correction = () => db.prepare(`
    SELECT status, payload_json FROM sync_outbox
    WHERE operation_type = 'product.upsert' AND aggregate_id = ?
  `).get(productId) as { status: string; payload_json: string } | undefined

  const saleStatus = (sequence: number) => (db.prepare('SELECT status, attempts FROM sync_outbox WHERE sequence = ?')
    .get(sequence) as { status: string; attempts: number })

  it('піднімає залишок сервера до касового плюс проданe і повертає чек у чергу', () => {
    queueSale({ sequence: 200, qty: 2, attempts: MAX_OUTBOX_ATTEMPTS })
    const sync = new LocalSyncRepository(db)

    sync.applyPushResults([])

    // На касі лишилось 3, у чеку 2 — отже до чека на сервері мало бути 5.
    // Сервер прийме продаж, відніме 2 і зійдеться з касою.
    expect(JSON.parse(correction()!.payload_json)).toMatchObject({ qty_on_hand: 5, stock_correction: true })
    const sale = saleStatus(200)
    expect(sale.status).toBe('pending')
    expect(sale.attempts).toBe(0)
  })

  it('чекає, поки вичерпаються спроби', () => {
    queueSale({ sequence: 200, qty: 2, attempts: MAX_OUTBOX_ATTEMPTS - 1 })
    const sync = new LocalSyncRepository(db)

    sync.applyPushResults([])

    expect(correction()).toBeUndefined()
    expect(saleStatus(200).status).toBe('failed')
  })

  it('не чіпає чек, поки по товару щось інше стоїть у черзі', () => {
    queueSale({ sequence: 200, qty: 2, attempts: MAX_OUTBOX_ATTEMPTS })
    db.prepare(`
      INSERT INTO sync_outbox(
        sequence, operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, attempts, created_at
      ) VALUES (201, ?, ?, 'device-1', 'supply_invoice', ?, 'supplier_invoice.posted', ?, 'pending', 0,
                '2026-09-03T10:40:00.000Z')
    `).run(
      randomUUID(), DEFAULT_TENANT_ID, randomUUID(),
      JSON.stringify({ items: [{ product_id: productId, qty: 10 }] }),
    )
    const sync = new LocalSyncRepository(db)

    sync.applyPushResults([])

    // Прихід ще не доїхав — саме він може зняти проблему без жодних виправлень.
    expect(correction()).toBeUndefined()
    expect(saleStatus(200).status).toBe('failed')
  })

  it('не чіпає чек, відхилений з іншої причини', () => {
    queueSale({ sequence: 200, qty: 2, attempts: MAX_OUTBOX_ATTEMPTS, error: 'Зміну не знайдено' })
    const sync = new LocalSyncRepository(db)

    sync.applyPushResults([])

    expect(correction()).toBeUndefined()
    expect(saleStatus(200).status).toBe('failed')
  })
})
