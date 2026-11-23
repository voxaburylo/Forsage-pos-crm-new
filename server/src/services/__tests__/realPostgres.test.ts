import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// 23.11.2026 (план T4): запити сервера — на справжньому Postgres, а не на заглушках.
// Того дня видалення замовлення з каси проходило всі тести й падало лише на справжній базі
// («FOR UPDATE is not allowed with GROUP BY clause»). PGlite — справжній Postgres без Docker; на ньому
// проганяються всі міграції Supabase, а сервіси сервера працюють через звичайний pool.
const state = vi.hoisted(() => {
  // Хмарні ключі не потрібні: запити йдуть у PGlite. Значення — лише щоб модулі завантажились.
  process.env.SUPABASE_URL ||= 'http://localhost'
  process.env.SUPABASE_SERVICE_KEY ||= 'test'
  process.env.SUPABASE_ANON_KEY ||= 'test'
  return { db: null as any }
})

vi.mock('../../db/pg', () => {
  const run = async (text: string, params: unknown[] = []) => {
    const result = await state.db.query(text, params)
    // Як у pg: для запитів із рядками — їх кількість, для змін — скільки рядків змінено.
    return { rows: result.rows, rowCount: result.fields?.length ? result.rows.length : (result.affectedRows ?? 0) }
  }
  const client = { query: (text: string, params?: unknown[]) => run(text, params), release: () => {} }
  const pool = { query: (text: string, params?: unknown[]) => run(text, params), connect: async () => client }
  return {
    pool,
    runTransaction: async <T>(callback: (c: typeof client) => Promise<T>): Promise<T> => {
      await run('BEGIN')
      try { const value = await callback(client); await run('COMMIT'); return value } catch (error) { await run('ROLLBACK'); throw error }
    },
  }
})

const tenant = randomUUID()

beforeAll(async () => {
  // @ts-expect-error — скрипт без типів (звичайний .mjs), його ж запускає CI окремо
  const { migratedDatabase } = await import('../../../scripts/pg-migrations-check.mjs')
  const { db, failures } = await migratedDatabase()
  state.db = db
  expect(failures).toEqual([])
}, 240_000)
afterAll(async () => { await state.db?.close() })

describe('server queries on a real Postgres with all Supabase migrations', () => {
  it('the old order-delete query is really refused by Postgres — the check catches this kind of bug', async () => {
    await expect(state.db.query(`SELECT o.status, COUNT(p.id) FROM customer_orders o LEFT JOIN order_payments p ON p.order_id = o.id
      WHERE o.id = $1 GROUP BY o.id FOR UPDATE`, [randomUUID()])).rejects.toThrow(/FOR UPDATE is not allowed with GROUP BY/)
  })

  it('an order deleted at the till is deleted on the server (the real query, 23.11.2026)', async () => {
    const { applyOrderDeleted } = await import('../sync/orderHandlers')
    const orderId = randomUUID()
    await state.db.query(`INSERT INTO customer_orders (id, tenant_id, order_number, status, manager_id) VALUES ($1, $2, 990001, 'new', gen_random_uuid())`, [orderId, tenant])
    await applyOrderDeleted(tenant, randomUUID(), { aggregate_id: orderId, payload: {}, created_at: new Date().toISOString() } as never)
    const row = await state.db.query('SELECT deleted_at FROM customer_orders WHERE id = $1', [orderId])
    expect(row.rows[0].deleted_at).not.toBeNull()
  })

  it('the till status report and server errors are written and read back (plan T2, T3)', async () => {
    const { saveStatusReport, recordServerError, readSystemStatus } = await import('../systemStatusService')
    await state.db.query(`INSERT INTO till_presence (tenant_id, device_id, seen_at) VALUES ($1, gen_random_uuid(), now())`, [tenant])
    expect(await saveStatusReport(tenant, { mode: 'background', role: 'main', release_id: 'r1', manager_release_id: 'r0' })).toBe(true)
    await recordServerError({ tenantId: tenant, source: 'request', route: 'POST /api/v1/x', status: 500, code: 'E1', message: 'boom' })
    await recordServerError({ tenantId: tenant, source: 'request', route: 'POST /api/v1/x', status: 500, code: 'E1', message: 'boom' })
    const status = await readSystemStatus(tenant)
    expect(status.till.report).toMatchObject({ release_id: 'r1', manager_release_id: 'r0', mode: 'background' })
    expect(status.errors.rows).toHaveLength(1)
    expect(status.errors.rows[0]).toMatchObject({ message: 'boom', repeats: 2 })
  })
})
