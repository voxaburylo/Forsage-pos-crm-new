import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('../../db/supabase.js', () => ({ db: {} }))
vi.mock('../../db/pg.js', () => ({ pool: {}, runTransaction: (fn: any) => state.db.transaction((tx: any) => fn({
  query: async (sql: string, args: any[]) => {
    const result = await tx.query(sql, args)
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }
  },
})) }))
import { applyBalanceSnapshot, validateBalanceSnapshot } from '../sync/balanceMirror.js'
const tenant = randomUUID(), product = randomUUID(), customer = randomUUID()
const keys = generateKeyPairSync('ed25519')
const snapshot = (version: number, qty: number) => {
  const raw = { source_version: version,
  products: [{ id: product, qty_on_hand: qty }],
  customers: [{ id: customer, debt_balance: 1000, deposit_balance: 500, bonus_balance: 200 }],
  }
  return { ...raw, signature: sign(null, Buffer.from(JSON.stringify({ tenant_id: tenant, device_id: 'primary', snapshot: raw })), keys.privateKey).toString('base64') }
}
beforeEach(async () => {
  state.db = new PGlite()
  await state.db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE products(id uuid PRIMARY KEY, tenant_id uuid, qty_on_hand numeric);
    CREATE TABLE customers(id uuid PRIMARY KEY, tenant_id uuid, debt_balance bigint, deposit_balance bigint, bonus_balance bigint);
    INSERT INTO products VALUES ('${product}','${tenant}',99);
    INSERT INTO customers VALUES ('${customer}','${tenant}',9999,8888,7777);`)
  await state.db.exec(readFileSync(new URL('../../../../supabase/migrations/20260911183427_local_balance_mirror.sql', import.meta.url), 'utf8'))
  await state.db.query('INSERT INTO local_mirror_authorities(tenant_id,device_id,public_key) VALUES ($1,$2,$3)',
    [tenant,'primary',keys.publicKey.export({type:'spki',format:'pem'}).toString()])
})
afterEach(async () => state.db.close())
const qty = async () => Number((await state.db.query('SELECT qty_on_hand FROM products')).rows[0].qty_on_hand)
describe('local authoritative balances', () => {
  it('copies exact current stock and balances, with idempotent redelivery', async () => {
    await applyBalanceSnapshot(tenant, 'primary', snapshot(12,3))
    await applyBalanceSnapshot(tenant, 'primary', snapshot(12,3))
    expect(await qty()).toBe(3)
    const row = (await state.db.query('SELECT * FROM customers')).rows[0]
    expect([row.debt_balance,row.deposit_balance,row.bonus_balance].map(Number)).toEqual([1000,500,200])
    expect((await state.db.query('SELECT * FROM local_balance_mirror')).rows).toHaveLength(2)
  })
  it('rejects conflicting same-version snapshots and ignores older deliveries', async () => {
    await applyBalanceSnapshot(tenant,'primary',snapshot(12,3))
    await applyBalanceSnapshot(tenant,'primary',snapshot(11,20))
    expect(await qty()).toBe(3)
    await expect(applyBalanceSnapshot(tenant,'primary',snapshot(12,20))).rejects.toThrow('різні залишки')
    expect(await qty()).toBe(3)
    await applyBalanceSnapshot(tenant,'primary',snapshot(13,2))
    expect(await qty()).toBe(2)
  })
  it('does not allow replayed sale/return/inventory deltas to change canonical values', async () => {
    await applyBalanceSnapshot(tenant,'primary',snapshot(12,3))
    await state.db.exec(`UPDATE products SET qty_on_hand=qty_on_hand-2;
      UPDATE products SET qty_on_hand=qty_on_hand+10;
      UPDATE products SET qty_on_hand=8;
      UPDATE customers SET debt_balance=debt_balance+500, deposit_balance=0, bonus_balance=bonus_balance-100;`)
    expect(await qty()).toBe(3)
    const row = (await state.db.query('SELECT * FROM customers')).rows[0]
    expect([row.debt_balance,row.deposit_balance,row.bonus_balance].map(Number)).toEqual([1000,500,200])
  })
  it('rejects an unregistered device or another tenant without changing data', async () => {
    await expect(applyBalanceSnapshot(tenant,'other',snapshot(12,3))).rejects.toThrow('не зареєстрована')
    await expect(applyBalanceSnapshot(randomUUID(),'primary',snapshot(12,3))).rejects.toThrow('не зареєстрована')
    expect(await qty()).toBe(99)
  })
  it('rejects malformed snapshots and duplicate IDs before writing', () => {
    expect(() => validateBalanceSnapshot({ ...snapshot(1,3), source_version: -1 })).toThrow()
    expect(() => validateBalanceSnapshot(snapshot(1,NaN))).toThrow()
    expect(() => validateBalanceSnapshot({ ...snapshot(1,3), products: [snapshot(1,3).products[0], snapshot(1,3).products[0]] })).toThrow()
  })
  it('does not trust a claimed device ID without its signature', async () => {
    const forged=snapshot(12,3); forged.products[0].qty_on_hand=999
    await expect(applyBalanceSnapshot(tenant,'primary',forged)).rejects.toThrow('Підпис')
    expect(await qty()).toBe(99)
  })
})
