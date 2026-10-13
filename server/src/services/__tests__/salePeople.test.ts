import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { readSaleOrderSource, readSalePeople } from '../salePeople.js'

const pg = new PGlite()
const cashier = '11111111-1111-4111-8111-111111111111'
const manager = 'abcdef22-2222-4222-8222-222222222222'
const foreign = '33333333-3333-4333-8333-333333333333'
const query = (sql: string, params: unknown[]) => pg.query<any>(sql, params)
beforeAll(async () => {
  await pg.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY, raw_user_meta_data jsonb, raw_app_meta_data jsonb);')
  await pg.exec('CREATE TABLE customer_orders(id uuid PRIMARY KEY, tenant_id text, sale_id uuid, deleted_at timestamptz);')
  await pg.query('INSERT INTO customer_orders VALUES($1,$2,$3,NULL),($4,$5,$6,NULL),($7,$2,$8,now())', [cashier, 'shop', cashier, manager, 'other', manager, foreign, foreign])
  for (const [id, name, tenant, active] of [[cashier, 'Касир', 'shop', true], [manager, 'Менеджер', 'shop', false], [foreign, 'Чужий', 'other', true]] as const) {
    await pg.query('INSERT INTO auth.users VALUES($1,$2,$3)', [id, { full_name: name, tenant_id: 'shop' }, { tenant_id: tenant, is_active: active, deleted_at: active ? null : '2026-01-01' }])
  }
})
afterAll(async () => { await pg.close() })
it('loads distinct historical cashier and inactive manager in one scoped query', async () => {
  const people = await readSalePeople(query, 'shop', cashier, manager)
  expect(people.cashier).toMatchObject({ id: cashier, full_name: 'Касир', is_active: true })
  expect(people.manager).toMatchObject({ id: manager, full_name: 'Менеджер', is_active: false, deleted_at: '2026-01-01' })
})
it('ignores spoofed user metadata and does not expose another tenant', async () => {
  expect(await readSalePeople(query, 'shop', foreign, null)).toEqual({ cashier: null, manager: null })
})
it('normalizes valid UUID casing from historical records', async () => {
  const people = await readSalePeople(query, 'shop', cashier, manager.toUpperCase())
  expect(people.manager?.full_name).toBe('Менеджер')
})
it('legacy missing IDs do not cause uuid cast errors or guessed names', async () => {
  expect(await readSalePeople(query, 'shop', 'local', null)).toEqual({ cashier: null, manager: null })
  expect(await readSalePeople(query, 'shop', '44444444-4444-4444-8444-444444444444', null)).toEqual({ cashier: null, manager: null })
})
it('query failure is not misrepresented as a missing historical author', async () => {
  await expect(readSalePeople(async () => { throw Error('read failed') }, 'shop', cashier, null)).rejects.toThrow('read failed')
})
it('identifies an order sale only from a live same-tenant document link', async () => {
  expect(await readSaleOrderSource(query, 'shop', cashier)).toBe(true)
  expect(await readSaleOrderSource(query, 'shop', manager)).toBe(false)
  expect(await readSaleOrderSource(query, 'shop', foreign)).toBe(false)
})
