import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalBootstrapRepository } from '../src/repositories/bootstrapRepository'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

/**
 * Скарга власника: «постійно робимо ревізію, щоб вирівняти кількість, а вона
 * знову не та». Причина була не в ревізії, а в тому, що позначку «змінено
 * локально» знімали з товару, поки його підрахунок ще стояв у черзі: наступний
 * pull повертав серверний залишок, і перерахунок зникав.
 */
describe('підрахунок ревізії переживає синхронізацію', () => {
  let root = ''
  let db: LocalDatabase
  const productId = '11111111-1111-4111-8111-111111111111'

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-count-'))
    db = new LocalDatabase(root)
    db.prepare(`
      INSERT INTO products(id, tenant_id, sku, name, qty_on_hand, dirty_at, created_at, updated_at)
      VALUES (?, ?, 'SKU-77', 'Олива для тесту', 4, '2026-09-03T09:43:00.000Z',
              '2026-01-01T00:00:00.000Z', '2026-09-03T09:43:00.000Z')
    `).run(productId, DEFAULT_TENANT_ID)
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  function queueInventory(status: 'pending' | 'failed'): void {
    db.prepare(`
      INSERT INTO sync_outbox(
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, attempts, created_at, last_error
      ) VALUES (?, ?, 'device-1', 'inventory', ?, 'inventory.completed', ?, ?, 30,
                '2026-09-03T09:43:00.000Z', 'Залишок товару змінився після початку ревізії')
    `).run(
      randomUUID(), DEFAULT_TENANT_ID, randomUUID(),
      JSON.stringify({ items: [{ product_id: productId, counted_stock: 4, expected_stock: 4 }] }),
      status,
    )
  }

  const currentQty = () => (db.prepare('SELECT qty_on_hand FROM products WHERE id = ?')
    .get(productId) as { qty_on_hand: number }).qty_on_hand
  const dirtyAt = () => (db.prepare('SELECT dirty_at FROM products WHERE id = ?')
    .get(productId) as { dirty_at: string | null }).dirty_at

  function pullServerStock(qty: number): void {
    new LocalBootstrapRepository(db).applySyncChanges(DEFAULT_TENANT_ID, {
      tenant_id: DEFAULT_TENANT_ID,
      cursor: '2026-09-03T10:00:00.000Z',
      products: [{
        id: productId,
        tenant_id: DEFAULT_TENANT_ID,
        sku: 'SKU-77',
        name: 'Олива для тесту',
        qty_on_hand: qty,
        updated_at: '2026-09-03T10:00:00.000Z',
      }],
    } as any)
  }

  it('не знімає позначку, поки ревізія стоїть у черзі, і сервер не перебиває підрахунок', () => {
    queueInventory('failed')

    // Кожен старт каси перебирає «осиротілі» позначки.
    new LocalSyncRepository(db)

    expect(dirtyAt()).not.toBeNull()

    pullServerStock(0)
    // Порахували 4 — стільки й лишається, поки підрахунок не доїхав на сервер.
    expect(currentQty()).toBe(4)
  })

  it('віддає товар серверу, щойно по ньому не лишилося невідправленої роботи', () => {
    new LocalSyncRepository(db)

    expect(dirtyAt()).toBeNull()

    pullServerStock(9)
    expect(currentQty()).toBe(9)
  })

  it('підтверджений продаж не звільняє товар, поки його тримає ревізія', () => {
    queueInventory('pending')
    const sync = new LocalSyncRepository(db)
    const saleOperationId = randomUUID()
    db.prepare(`
      INSERT INTO sync_outbox(
        sequence, operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, attempts, created_at
      ) VALUES (5000, ?, ?, 'device-1', 'sale', ?, 'sale.completed', ?, 'pending', 0,
                '2026-09-03T09:44:00.000Z')
    `).run(
      saleOperationId, DEFAULT_TENANT_ID, randomUUID(),
      JSON.stringify({ items: [{ product_id: productId, qty: 1 }] }),
    )

    sync.applyPushResults([{ sequence: 5000, operation_id: saleOperationId, status: 'synced' } as any])

    // Продаж прийнято, але залишок ще тримає ревізія в черзі.
    expect(dirtyAt()).not.toBeNull()
    pullServerStock(0)
    expect(currentQty()).toBe(4)
  })
})
