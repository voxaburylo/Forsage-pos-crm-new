import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }))
vi.mock('../../db/pg.js', () => ({ runTransaction: mocks.transaction }))
vi.mock('../sync/syncCore.js', () => ({ isUuid: (value: string) => Boolean(value) }))
import { applyInventoryCompleted } from '../sync/inventoryHandlers.js'

describe('historical inventory document copy', () => {
  const db = new PGlite()
  const session = '11111111-1111-4111-8111-111111111111'
  const product = '22222222-2222-4222-8222-222222222222'
  const operation = (items = [{ product_id: product, expected_stock: 8, counted_stock: 3 }]) => ({
    operation_type: 'inventory.document_copied', aggregate_id: session,
    created_at: '2026-09-01T12:00:00.000Z', payload: { id: session, items },
  } as any)

  beforeAll(async () => {
    await db.exec(`
      CREATE TABLE products(id uuid PRIMARY KEY, tenant_id text, qty_on_hand numeric, updated_at timestamptz, deleted_at timestamptz);
      CREATE TABLE inventory_sessions(id uuid PRIMARY KEY, tenant_id text, name text, status text,
        created_by text, started_by text, started_at timestamptz, completed_at timestamptz, created_at timestamptz, updated_at timestamptz);
      CREATE TABLE inventory_items(id serial PRIMARY KEY, session_id uuid REFERENCES inventory_sessions(id),
        product_id uuid REFERENCES products(id), expected_stock numeric, counted_stock numeric, was_counted boolean,
        price_checked boolean, last_counted_by text, created_at timestamptz, updated_at timestamptz, UNIQUE(session_id, product_id));
      CREATE TABLE inventory_count_entries(id uuid PRIMARY KEY, tenant_id text, session_id uuid,
        inventory_item_id integer REFERENCES inventory_items(id), product_id uuid, counted_by text,
        qty numeric, price_checked boolean, observed_retail_price numeric, created_at timestamptz);
    `)
    mocks.transaction.mockImplementation((fn) => db.transaction((tx) => fn({
      query: async (sql: string, args?: unknown[]) => {
        const result = await tx.query(sql, args)
        return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }
      },
    })))
  }, 30000)
  beforeEach(async () => {
    await db.exec(`TRUNCATE inventory_count_entries, inventory_items, inventory_sessions, products CASCADE;
      INSERT INTO products VALUES ('${product}', 'shop', 2, '2026-09-06', NULL);`)
  })
  afterAll(() => db.close())

  it('copies all history while leaving current stock and its timestamp untouched', async () => {
    const before = await db.query('SELECT * FROM products')
    await applyInventoryCompleted('shop', 'user', operation())
    expect((await db.query('SELECT * FROM products')).rows).toEqual(before.rows)
    expect((await db.query('SELECT status FROM inventory_sessions')).rows).toEqual([{ status: 'completed' }])
    expect((await db.query('SELECT expected_stock, counted_stock FROM inventory_items')).rows).toEqual([{ expected_stock: '8', counted_stock: '3' }])
    await applyInventoryCompleted('shop', 'user', operation())
    expect((await db.query('SELECT * FROM inventory_count_entries')).rows).toHaveLength(1)
  })

  it('rolls the whole document back if any product is missing', async () => {
    await expect(applyInventoryCompleted('shop', 'user', operation([
      { product_id: product, expected_stock: 8, counted_stock: 3 },
      { product_id: '33333333-3333-4333-8333-333333333333', expected_stock: 0, counted_stock: 1 },
    ]))).rejects.toThrow('Товар ревізії не знайдено')
    expect((await db.query('SELECT * FROM inventory_sessions')).rows).toHaveLength(0)
    expect((await db.query('SELECT * FROM inventory_items')).rows).toHaveLength(0)
  })

  it('rejects a foreign shop and duplicate rows', async () => {
    await expect(applyInventoryCompleted('other', 'user', operation())).rejects.toThrow('Товар ревізії не знайдено')
    const item = { product_id: product, expected_stock: 8, counted_stock: 3 }
    await expect(applyInventoryCompleted('shop', 'user', operation([item, item]))).rejects.toThrow('повторні товари')
    expect((await db.query('SELECT * FROM inventory_sessions')).rows).toHaveLength(0)
  })

  it('still rejects conflicting stock for an ordinary inventory completion', async () => {
    await expect(applyInventoryCompleted('shop', 'user', { ...operation(), operation_type: 'inventory.completed' })).rejects.toThrow('Залишок товару змінився')
  })
})
