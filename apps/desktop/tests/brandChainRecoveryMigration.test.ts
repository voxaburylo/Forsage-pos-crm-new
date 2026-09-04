import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'

/**
 * Каса місяцями складала в dead-letter товари й прихідні накладні, бо касиру
 * було заборонено надсилати бренд: бренд не долітав -> товар падав на
 * products_brand_id_fkey -> прихід падав на товарі. Після виправлення прав ці
 * операції треба повернути в чергу, інакше залишки так і лишаться розбіжними.
 */
describe('migration 23 — оживлення черги, що стояла через бренд', () => {
  let root = ''
  let db: LocalDatabase | null = null

  afterEach(() => {
    db?.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-brand-chain-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('повертає в чергу весь ланцюжок і не чіпає чужі відмови', () => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-brand-chain-'))
    db = new LocalDatabase(root)

    const insert = (operationType: string, aggregateType: string, error: string) => {
      const operationId = randomUUID()
      db!.prepare(`
        INSERT INTO sync_outbox (
          operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
          operation_type, payload_json, status, attempts, next_attempt_at, created_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, '{}', 'failed', 30, '2099-01-01T00:00:00.000Z', ?, ?)
      `).run(
        operationId, DEFAULT_TENANT_ID, db!.deviceId, aggregateType, randomUUID(),
        operationType, new Date().toISOString(), error,
      )
      return operationId
    }

    const brand = insert('brand.upsert', 'brand', 'Недостатньо прав для цієї операції синхронізації')
    const category = insert('category.upsert', 'category', 'Недостатньо прав для цієї операції синхронізації')
    const product = insert('product.upsert', 'product',
      'insert or update on table "products" violates foreign key constraint "products_brand_id_fkey"')
    const invoice = insert('supplier_invoice.created', 'supply_invoice',
      'insert or update on table "supply_invoice_items" violates foreign key constraint "supply_invoice_items_product_id_fkey"')
    const posted = insert('supplier_invoice.posted', 'supply_invoice', 'Накладну не знайдено')
    // Оновлений сервер називає ту саму причину словами, а не іменем constraint.
    const explained = insert('product.upsert', 'product',
      'Бренд товару ще не синхронізовано з сервером. Товар буде надіслано разом із нею.')

    // Чужі відмови: ревізія переписала б залишки заднім числом, а продаж
    // упав із власної причини — обидва мають лишитись у dead-letter.
    const inventory = insert('inventory.completed', 'inventory', 'Товар ревізії не знайдено: 5e0ca4ac')
    const sale = insert('sale.completed', 'sale', 'Зміну вже закрито')

    db.prepare('DELETE FROM schema_migrations WHERE version = 23').run()
    db.prepare('DROP TABLE IF EXISTS problem_log').run()
    db.close()
    db = new LocalDatabase(root)

    const statusOf = (operationId: string): { status: string; attempts: number } => db!.prepare(`
      SELECT status, attempts FROM sync_outbox WHERE operation_id = ?
    `).get(operationId) as { status: string; attempts: number }

    for (const operationId of [brand, category, product, invoice, posted, explained]) {
      expect(statusOf(operationId)).toMatchObject({ status: 'pending', attempts: 0 })
    }
    for (const operationId of [inventory, sale]) {
      expect(statusOf(operationId).status).toBe('failed')
    }
  })

  it('створює таблицю журналу проблем', () => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-brand-chain-'))
    db = new LocalDatabase(root)
    const table = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'problem_log'
    `).get() as { name: string } | undefined
    expect(table?.name).toBe('problem_log')
  })
})
