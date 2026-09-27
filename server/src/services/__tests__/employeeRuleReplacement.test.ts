import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'

const state = vi.hoisted(() => ({ db: null as any, tenant: '', archived: false }))
vi.mock('../../db/supabase.js', () => ({ db: {} }))
vi.mock('../../db/supabaseAdmin.js', () => ({ supabaseAdmin: { auth: { admin: {
  getUserById: async () => ({ data: { user: { app_metadata: { tenant_id: state.tenant, role: 'cashier', deleted_at: state.archived ? '2026-09-16' : null } } }, error: null }),
} } } }))
vi.mock('../../db/pg.js', () => ({ runTransaction: (fn: any) => state.db.transaction((tx: any) => fn(tx)) }))
import { replaceEmployeeRules } from '../commissionService.js'

const tenant = randomUUID(), employee = randomUUID(), other = randomUUID(), category = randomUUID()
beforeEach(async () => {
  state.tenant = tenant; state.archived = false; state.db = new PGlite()
  await state.db.exec(`CREATE TABLE commission_rules(id uuid PRIMARY KEY, tenant_id uuid, user_id uuid, brand_id uuid, category_id uuid, rule_type text, pct_from_revenue numeric, pct_from_profit numeric)`)
  for (const [user, scope] of [[employee,null],[employee,category],[other,null]]) {
    await state.db.query("INSERT INTO commission_rules VALUES($1,$2,$3,NULL,$4,'pos_sales',5,0)", [randomUUID(),tenant,user,scope])
  }
})
afterEach(async () => { await state.db.close() })
const rows = async () => (await state.db.query('SELECT * FROM commission_rules ORDER BY id')).rows
describe('atomic replacement of employee commission settings', () => {
  it('replaces only the employee generic rules, retaining scoped and other employee rules', async () => {
    await replaceEmployeeRules(employee,[{rule_type:'order_sales',pct_from_revenue:7,pct_from_profit:0}],tenant)
    expect(await rows()).toHaveLength(3)
    await replaceEmployeeRules(employee,[],tenant)
    const retained = await rows()
    expect(retained).toHaveLength(2)
    expect(retained.some((row:any)=>row.category_id===category)).toBe(true)
    expect(retained.some((row:any)=>row.user_id===other)).toBe(true)
  })
  it('restores deleted old rules if an insert fails midway', async () => {
    const before = await rows()
    await state.db.exec("ALTER TABLE commission_rules ADD CONSTRAINT simulate_insert_failure CHECK (pct_from_revenue <> 9)")
    await expect(replaceEmployeeRules(employee,[{rule_type:'pos_sales',pct_from_revenue:8,pct_from_profit:0},{rule_type:'order_sales',pct_from_revenue:9,pct_from_profit:0}],tenant)).rejects.toThrow()
    expect(await rows()).toEqual(before)
  })
  it('rejects invalid settings and cross-tenant or archived employees without changing data', async () => {
    const before = await rows()
    for (const value of [NaN,Infinity,-1,101]) await expect(replaceEmployeeRules(employee,[{rule_type:'pos_sales',pct_from_revenue:value,pct_from_profit:0}],tenant)).rejects.toThrow('Некоректні')
    await expect(replaceEmployeeRules(employee,[],randomUUID())).rejects.toThrow('не знайдено')
    state.archived=true
    await expect(replaceEmployeeRules(employee,[],tenant)).rejects.toThrow('не знайдено')
    expect(await rows()).toEqual(before)
  })
})
