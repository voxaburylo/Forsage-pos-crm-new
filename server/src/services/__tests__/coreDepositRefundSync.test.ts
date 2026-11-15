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
import { applySaleCoreDepositRefunded } from '../sync/salesHandlers.js'
import { isSyncOperationAllowed } from '../sync/operationsCatalog.js'

const tenant = randomUUID(), otherTenant = randomUUID(), sale = randomUUID()
const pending = randomUUID(), plain = randomUUID(), foreign = randomUUID(), foreignSale = randomUUID()
const applied = '2026-11-13T12:00:00.000Z'

function operation(saleItemId: string, saleId = sale): any {
  return { sequence: 1, operation_id: randomUUID(), tenant_id: tenant, device_id: 'till', aggregate_type: 'sale',
    aggregate_id: saleId, operation_type: 'sale.core_deposit_refunded', created_at: applied, applied_at: applied,
    payload: { sale_id: saleId, sale_item_id: saleItemId, amount: 20000, cash_operation_id: randomUUID() } }
}
const row = async (id: string) => (await state.db.query('SELECT core_return_status FROM sale_items WHERE id=$1', [id])).rows[0]
const touched = async (id: string) => (await state.db.query('SELECT updated_at FROM sales WHERE id=$1', [id])).rows[0].updated_at

beforeEach(async () => {
  state.db = new PGlite()
  await state.db.exec(`
    CREATE TABLE sales(id uuid PRIMARY KEY, tenant_id uuid, updated_at timestamptz);
    CREATE TABLE sale_items(id uuid PRIMARY KEY, tenant_id uuid, sale_id uuid REFERENCES sales,
      core_deposit_amount bigint DEFAULT 0, core_return_status text DEFAULT 'none');
    INSERT INTO sales VALUES('${sale}','${tenant}','2026-11-01T10:00:00Z');
    INSERT INTO sales VALUES('${foreignSale}','${otherTenant}','2026-11-01T10:00:00Z');
    INSERT INTO sale_items VALUES('${pending}','${tenant}','${sale}',20000,'pending');
    INSERT INTO sale_items VALUES('${plain}','${tenant}','${sale}',0,'none');
    INSERT INTO sale_items VALUES('${foreign}','${otherTenant}','${foreignSale}',20000,'pending');`)
})
afterEach(async () => state.db.close())

describe('sale.core_deposit_refunded', () => {
  it('marks the receipt line refunded and touches the receipt so the next pull carries it', async () => {
    await applySaleCoreDepositRefunded(tenant, operation(pending))
    expect(await row(pending)).toEqual({ core_return_status: 'refunded' })
    expect(new Date(await touched(sale)).toISOString()).toBe(applied)
  })
  it('accepts a redelivery without changing anything', async () => {
    await applySaleCoreDepositRefunded(tenant, operation(pending))
    await state.db.query("UPDATE sales SET updated_at='2026-12-01T00:00:00Z' WHERE id=$1", [sale])
    await applySaleCoreDepositRefunded(tenant, operation(pending))
    expect(await row(pending)).toEqual({ core_return_status: 'refunded' })
    expect(new Date(await touched(sale)).toISOString()).toBe('2026-12-01T00:00:00.000Z')
  })
  it('waits for the receipt instead of acknowledging a refund it cannot record', async () => {
    await expect(applySaleCoreDepositRefunded(tenant, operation(randomUUID()))).rejects.toMatchObject({ code: 'SYNC_CORE_DEPOSIT_SALE_REQUIRED' })
  })
  it('never touches another shop\'s receipt', async () => {
    await expect(applySaleCoreDepositRefunded(tenant, operation(foreign, foreignSale))).rejects.toMatchObject({ code: 'SYNC_CORE_DEPOSIT_SALE_REQUIRED' })
    expect(await row(foreign)).toEqual({ core_return_status: 'pending' })
  })
  it('rejects a line that has no deposit and malformed identifiers', async () => {
    await expect(applySaleCoreDepositRefunded(tenant, operation(plain))).rejects.toMatchObject({ code: 'SYNC_CORE_DEPOSIT_INVALID' })
    await expect(applySaleCoreDepositRefunded(tenant, operation('not-a-uuid'))).rejects.toMatchObject({ code: 'SYNC_CORE_DEPOSIT_INVALID' })
    expect(await row(plain)).toEqual({ core_return_status: 'none' })
  })
  it('is ordinary shop work: any till role may deliver it', () => {
    for (const role of ['owner', 'cashier', 'manager']) expect(isSyncOperationAllowed(role, 'sale.core_deposit_refunded')).toBe(true)
  })
})
