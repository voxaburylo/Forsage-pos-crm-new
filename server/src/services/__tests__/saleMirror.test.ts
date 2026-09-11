import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('../../db/supabase.js', () => ({ db: {} }))
vi.mock('../../db/pg.js', () => ({ pool: {}, runTransaction: (fn: any) => state.db.transaction((tx: any) => fn({
  query: async (sql: string, args: any[]) => {
    const result = await tx.query(sql, args)
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }
  },
})) }))
import { applySaleCompleted } from '../sync/salesHandlers.js'

const tenant = randomUUID(), product = randomUUID(), shift = randomUUID(), user = randomUUID()
const sale = () => ({ sequence: 1, operation_id: randomUUID(), tenant_id: tenant, device_id: 'test',
  aggregate_type: 'sale', aggregate_id: randomUUID(), operation_type: 'sale.completed',
  created_at: '2026-09-11T18:00:00Z', payload: {
    shift_id: shift, cashier_id: user, sale_number: randomUUID(), subtotal: 6000, discount: 0,
    total: 6000, payment_method: 'cash', payments: [{ method: 'cash', amount: 6000 }],
    completed_at: '2026-09-11T11:00:00Z', bonuses_spent: 500,
    items: [{ id: randomUUID(), product_id: product, qty: 2, unit_price: 3000,
      purchase_price: 1200, total: 6000, core_deposit_amount: 0 }],
  } })

beforeEach(async () => {
  state.db = new PGlite()
  await state.db.exec(`
    CREATE TABLE shifts(id uuid PRIMARY KEY, tenant_id uuid, status text);
    CREATE TABLE products(id uuid PRIMARY KEY, tenant_id uuid, qty_on_hand numeric, deleted_at timestamptz);
    CREATE TABLE customers(id uuid PRIMARY KEY, bonus_balance int, debt_balance int);
    CREATE TABLE sales(id uuid PRIMARY KEY, tenant_id uuid, sale_number text, customer_id uuid,
      cashier_id uuid, shift_id uuid REFERENCES shifts, status text, subtotal bigint, discount bigint,
      total bigint, payment_method text, is_debt boolean, notes text, manager_id uuid, cash_amount bigint,
      card_amount bigint, transfer_amount bigint, bonuses_spent bigint, is_fiscal boolean, fiscal_number text,
      fiscal_qr_url text, completed_at timestamptz, created_at timestamptz, updated_at timestamptz);
    CREATE TABLE sale_items(id uuid PRIMARY KEY, tenant_id uuid, sale_id uuid REFERENCES sales,
      product_id uuid REFERENCES products, qty numeric, unit_price bigint, discount bigint, total bigint,
      cost_price bigint, core_deposit_amount bigint, core_return_status text, created_at timestamptz);
    INSERT INTO shifts VALUES ('${shift}', '${tenant}', 'closed');
    INSERT INTO products VALUES ('${product}', '${tenant}', 0, now());
    INSERT INTO customers VALUES ('${user}', 0, 1000);
  `)
})
afterEach(async () => { await state.db.close() })

describe('completed local receipts are copied, not sold again', () => {
  it('copies a historical receipt against closed shift and deleted/zero-stock product, exactly once', async () => {
    const op = sale()
    await applySaleCompleted(tenant, user, op)
    await applySaleCompleted(tenant, user, op)
    const rows = (await state.db.query('SELECT * FROM sales')).rows
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].total)).toBe(6000)
    expect(rows[0].completed_at.toISOString()).toBe('2026-09-11T11:00:00.000Z')
    expect(rows[0].shift_id).toBe(shift)
    expect((await state.db.query('SELECT * FROM sale_items')).rows).toHaveLength(1)
    expect(Number((await state.db.query('SELECT qty_on_hand FROM products')).rows[0].qty_on_hand)).toBe(0)
    expect((await state.db.query('SELECT * FROM customers')).rows[0]).toMatchObject({ bonus_balance: 0, debt_balance: 1000 })
    expect((await state.db.query('SELECT status FROM shifts')).rows[0].status).toBe('closed')
  })
  it('rolls back a receipt whose product has not arrived yet', async () => {
    const op = sale(); op.payload.items[0].product_id = randomUUID()
    await expect(applySaleCompleted(tenant, user, op)).rejects.toThrow('Не передано картку товару')
    expect((await state.db.query('SELECT * FROM sales')).rows).toHaveLength(0)
  })
  it('refuses conflicting totals on redelivery', async () => {
    const op = sale(); await applySaleCompleted(tenant, user, op)
    op.payload.total = 1
    await expect(applySaleCompleted(tenant, user, op)).rejects.toThrow('іншу суму')
  })
  it('does not manufacture a new shift to fit a receipt', async () => {
    const op = sale(); op.payload.shift_id = randomUUID()
    await expect(applySaleCompleted(tenant, user, op)).rejects.toThrow('копію касової зміни')
    expect((await state.db.query('SELECT * FROM sales')).rows).toHaveLength(0)
  })
  it('rejects invalid quantities before writing', async () => {
    const op = sale(); op.payload.items[0].qty = -1
    await expect(applySaleCompleted(tenant, user, op)).rejects.toThrow('кількість')
    expect((await state.db.query('SELECT * FROM sales')).rows).toHaveLength(0)
  })
})
