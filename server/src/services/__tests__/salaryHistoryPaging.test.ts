import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ urls: [] as URL[], rows: 201, fail: false, summaryTotal: 0 }))
vi.mock('../../db/supabase.js', async () => {
  const { createClient } = await import('@supabase/supabase-js')
  return { db: createClient('https://database.invalid', 'test-only-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (url: any) => {
    state.urls.push(new URL(String(url)))
    if (state.summaryTotal) {
      const query = state.urls.at(-1)!.searchParams
      const start = Number(query.get('id')?.replace('gt.', '') ?? '-1') + 1
      const rows = Array.from({ length: Math.min(500, state.summaryTotal - start) }, (_, i) => ({ id: String(start + i).padStart(8, '0'), employee_id: 'worker', employee_name: 'Test', amount: 100, type: 'salary' }))
      return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(state.fail ? { message: 'Disconnected' } : Array.from({ length: state.rows }, (_, i) => ({ id: String(i), employee_id: i === 0 ? 'owner' : 'worker' }))), { status: state.fail ? 400 : 200, headers: { 'content-type': 'application/json' } })
  } } }) }
})
vi.mock('../../db/supabaseAdmin.js', () => ({ supabaseAdmin: {} }))
vi.mock('../../db/pg.js', () => ({ pool: {}, runTransaction: vi.fn() }))
vi.mock('../../middleware/auth.js', () => ({ requireAuth: vi.fn(), requireRole: () => vi.fn() }))
vi.mock('../adminService.js', () => ({ listUsers: async () => [{ id: 'owner', role: 'owner' }] }))
import router from '../../routes/salary.js'
const handler = (router as any).stack.find((layer: any) => layer.route?.path === '/' && layer.route.methods.get).route.stack.at(-1).handle
beforeEach(() => { state.urls = []; state.rows = 201; state.fail = false; state.summaryTotal = 0 })
async function request(query: Record<string, string>) {
  const json = vi.fn(), next = vi.fn()
  await handler({ query, user: { tenant_id: 'shop' } }, { json }, next)
  return { json, next }
}
it('fetches a lookahead row and filters owner operations without prematurely ending history', async () => {
  const { json, next } = await request({ period: '2026-09', employee_id: 'worker', page: '2' })
  expect(next).not.toHaveBeenCalled()
  const query = state.urls[0].searchParams
  expect(query.get('offset')).toBe('200'); expect(query.get('limit')).toBe('201')
  expect(query.get('order')).toBe('created_at.desc,id.desc')
  expect(query.get('tenant_id')).toBe('eq.shop'); expect(query.get('period')).toBe('eq.2026-09')
  expect(query.get('employee_id')).toBe('eq.worker')
  expect(json.mock.calls[0][0].data).toHaveLength(199)
  expect(json.mock.calls[0][0].has_more).toBe(true)
})
it('finishes an exact 200-row page without requesting an invalid next range', async () => {
  state.rows = 200
  expect((await request({ page: '1' })).json.mock.calls[0][0].has_more).toBe(false)
})
it('rejects invalid page input and surfaces failures instead of returning an empty month', async () => {
  expect((await request({ page: '-1' })).next.mock.calls[0][0]).toMatchObject({ status: 400 })
  expect(state.urls).toHaveLength(0)
  state.fail = true
  const { next, json } = await request({ page: '2' })
  expect(json).not.toHaveBeenCalled(); expect(next.mock.calls[0][0].message).toContain('Disconnected')
})
it.each(['/summary', '/daily-summary'])('includes all 1251 operations in %s, past the default server response cap', async route => {
  state.summaryTotal = 1251
  const handler = (router as any).stack.find((layer: any) => layer.route?.path === route).route.stack.at(-1).handle
  const json = vi.fn(), next = vi.fn()
  await handler({ query: { period: '2026-09', date: '2026-09-22' }, user: { tenant_id: 'shop' } }, { json }, next)
  expect(next).not.toHaveBeenCalled(); expect(json.mock.calls[0][0].data[0].earned).toBe(125100)
  expect(state.urls).toHaveLength(3)
  expect(state.urls[1].searchParams.get('id')).toBe('gt.00000499')
  expect(state.urls.every(url => url.searchParams.get('tenant_id') === 'eq.shop')).toBe(true)
})
