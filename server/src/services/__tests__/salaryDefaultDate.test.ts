import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ urls: [] as URL[], writes: [] as unknown[][] }))
const employeeId = '11111111-1111-4111-8111-111111111111'
vi.mock('../../db/supabase.js', async () => {
  const { createClient } = await import('@supabase/supabase-js')
  return { db: createClient('https://database.invalid', 'test-only-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (url: any) => {
      state.urls.push(new URL(String(url)))
      return new Response('[]', { headers: { 'content-type': 'application/json' } })
    } },
  }) }
})
vi.mock('../../db/supabaseAdmin.js', () => ({ supabaseAdmin: { auth: { admin: {
  getUserById: async () => ({ data: { user: { app_metadata: { tenant_id: 'shop', role: 'cashier' } } } }),
} } } }))
vi.mock('../../db/pg.js', () => ({ pool: {}, runTransaction: async (callback: any) => callback({
  query: async (_sql: string, values: unknown[]) => {
    state.writes.push(values)
    return { rows: [{ id: 'created', period: values[6], work_date: values[9] }], rowCount: 1 }
  },
}) }))
vi.mock('../../middleware/auth.js', () => ({ requireAuth: vi.fn(), requireRole: () => vi.fn() }))
vi.mock('../adminService.js', () => ({ listUsers: async () => [] }))
import router from '../../routes/salary.js'

beforeEach(() => {
  state.urls = []; state.writes = []
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => { vi.useRealTimers() })

async function request(route: string, method: 'get' | 'post', input: Record<string, unknown>) {
  const handler = (router as any).stack.find((layer: any) => layer.route?.path === route && layer.route.methods[method]).route.stack.at(-1).handle
  const json = vi.fn(), next = vi.fn(), response = { json, status: vi.fn() }
  response.status.mockReturnValue(response)
  await handler({ query: method === 'get' ? input : {}, body: method === 'post' ? input : {}, user: { tenant_id: 'shop', id: 'author' } }, response, next)
  expect(next).not.toHaveBeenCalled()
  expect(json).toHaveBeenCalledOnce()
  return json.mock.calls[0][0]
}

const boundaries = [
  ['2026-06-30T20:59:59.999Z', '2026-06-30'],
  ['2026-06-30T21:00:00.000Z', '2026-07-01'],
  ['2026-12-31T21:59:59.999Z', '2026-12-31'],
  ['2026-12-31T22:00:00.000Z', '2027-01-01'],
] as const

it.each(boundaries)('defaults legacy monthly reads to the Kyiv month at %s', async (now, date) => {
  vi.setSystemTime(new Date(now))
  for (const route of ['/summary', '/commission-preview']) {
    state.urls = []
    const result = await request(route, 'get', {})
    const salaries = state.urls.filter(url => url.pathname.endsWith('/salary_payments'))
    expect(salaries).toHaveLength(1)
    expect(salaries[0].searchParams.get('period')).toBe(`eq.${date.slice(0, 7)}`)
    expect(salaries[0].searchParams.get('tenant_id')).toBe('eq.shop')
    if (route === '/commission-preview') expect(result.period).toBe(date.slice(0, 7))
  }
  expect(state.writes).toHaveLength(0)
})

it.each(boundaries)('uses a consistent Kyiv workday and month for a legacy write at %s', async (now, date) => {
  vi.setSystemTime(new Date(now))
  const result = await request('/', 'post', { employee_id: employeeId, employee_name: 'Fixture', amount: 12550, type: 'salary', method: 'card' })
  expect(state.writes).toHaveLength(1)
  expect(state.writes[0][6]).toBe(date.slice(0, 7))
  expect(state.writes[0][9]).toBe(date)
  expect(result.data).toMatchObject({ period: date.slice(0, 7), work_date: date })
})

it('preserves explicitly selected past periods and workdays', async () => {
  vi.setSystemTime(new Date('2026-12-31T22:30:00Z'))
  for (const route of ['/summary', '/commission-preview']) {
    state.urls = []
    await request(route, 'get', { period: '2025-11' })
    expect(state.urls.find(url => url.pathname.endsWith('/salary_payments'))!.searchParams.get('period')).toBe('eq.2025-11')
  }
  const result = await request('/', 'post', { employee_id: employeeId, employee_name: 'Fixture', amount: 12550, method: 'card', period: '2025-11', work_date: '2025-11-04' })
  expect(result.data).toMatchObject({ period: '2025-11', work_date: '2025-11-04' })
})

it('preserves the existing independent period default when only work_date is explicit', async () => {
  vi.setSystemTime(new Date('2026-12-31T22:30:00Z'))
  const result = await request('/', 'post', { employee_id: employeeId, employee_name: 'Fixture', amount: 12550, method: 'card', period: null, work_date: '2026-11-04' })
  expect(result.data).toMatchObject({ period: '2027-01', work_date: '2026-11-04' })
})
