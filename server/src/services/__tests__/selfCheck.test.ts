import express, { Router } from 'express'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
vi.mock('../../db/supabase.js', () => ({ db: { storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) } } }))
import { SELF_CHECK_EVERY_MS, checkablePath, collectGetRoutes, runSelfCheck, runSelfCheckIfDue, selfCheckAlertText, selfCheckDue } from '../selfCheckService.js'
import { SELF_CHECK_HEADER, closeSelfCheckPass, openSelfCheckPass, selfCheckIdentity } from '../selfCheckAccess.js'

// 22.11.2026: «помилку сервера» у вебі знайшов власник із телефона — запит звертався до стовпця, якого немає
// в справжній базі. Тепер сервер сам перевіряє свої сторінки читання після публікації й раз на три години.
const NIL = '00000000-0000-4000-8000-000000000000'
const identity = { id: 'owner-1', email: '', tenant_id: 'shop-1' }

function sampleApp() {
  const app = express()
  const seen: Array<{ path: string; user: unknown }> = []
  const auth: express.RequestHandler = (req, res, next) => {
    const user = selfCheckIdentity(req)
    if (!user) { res.status(401).json({ error: { code: 'UNAUTHORIZED' } }); return }
    seen.push({ path: req.path, user })
    next()
  }
  const products = Router()
  products.use(auth)
  products.get('/', (_req, res) => { res.json({ data: [] }) })
  products.get('/:id', (_req, res) => { res.status(404).json({ error: { code: 'NOT_FOUND' } }) })
  products.post('/', (_req, res) => { res.json({ created: true }) })
  const salary = Router()
  salary.use(auth)
  salary.get('/tire-service-report', (_req, _res, next) => { next(new Error('column item.description does not exist')) })
  app.use('/api/v1/products', products)
  app.use('/api/v1/salary', salary)
  app.get('/api/v1/health', (_req, res) => { res.json({ status: 'ok' }) })
  app.use(((_err, _req, res, _next) => { res.status(500).json({ error: { code: 'INTERNAL_ERROR' } }) }) as express.ErrorRequestHandler)
  return { app, seen }
}

describe('the server checks its own read pages', () => {
  beforeEach(() => { query.mockReset(); closeSelfCheckPass(); vi.unstubAllGlobals() })

  it('takes the list of pages from the server itself, so a new page is checked without any list', () => {
    const { app } = sampleApp()
    expect(collectGetRoutes(app)).toEqual(['/api/v1/health', '/api/v1/products', '/api/v1/products/:id', '/api/v1/salary/tire-service-report'])
  })

  it('opens only safe read addresses: no jobs, till exchange, paid AI, sign-in, public links or exports', () => {
    expect(checkablePath('/api/v1/products')).toBe('/api/v1/products')
    expect(checkablePath('/api/v1/products/:id/stock')).toBe(`/api/v1/products/${NIL}/stock`)
    expect(checkablePath('/api/v1/customers/:id/history/:kind')).toBe(`/api/v1/customers/${NIL}/history/${NIL}`)
    expect(checkablePath('/api/v1/reports/:from?')).toBe('/api/v1/reports')
    for (const route of ['/api/v1/internal/owner-alerts', '/api/v1/jobs/:queueName/:jobId', '/api/v1/telegram/webhook', '/api/v1/sync/changes', '/api/v1/ai/usage',
      '/api/v1/vin/decode', '/api/v1/auth/me', '/api/v1/public/price-list/:token', '/api/v1/till-commands/status', '/api/v1/till-rpc/:id', '/api/v1/backups',
      '/api/v1/health', '/api/v1/products/export', '/api/v1/products/generate-barcode-only', '/api/v1/search/hybrid', '/other', '/api/v1/files/*'])
      expect(checkablePath(route), route).toBeNull()
  })

  it('reports exactly the pages that answer with an internal error, as the owner of the shop', async () => {
    const { app, seen } = sampleApp()
    const result = await runSelfCheck(app, identity)
    expect(result.checked).toBe(3)
    expect(result.failures).toEqual([{ path: '/api/v1/salary/tire-service-report', status: 500, code: 'INTERNAL_ERROR' }])
    expect(result.statuses).toEqual({ 200: 1, 404: 1, 500: 1 })
    expect(result.slow).toEqual([])
    expect(seen.every(entry => JSON.stringify(entry.user) === JSON.stringify({ ...identity, role: 'owner' }))).toBe(true)
    // «Не знайдено» чи «бракує параметра» — не збій.
    expect(result.failures.some(failure => failure.path.includes(NIL))).toBe(false)
  })

  it('the pass works only for reading, only during a run, and only with the exact value', async () => {
    const request = (method: string, value?: string) => ({ method, headers: value === undefined ? {} : { [SELF_CHECK_HEADER]: value } })
    expect(selfCheckIdentity(request('GET', 'a'.repeat(64)) as never)).toBeNull()
    const pass = openSelfCheckPass({ ...identity, role: 'owner' })
    expect(pass).toMatch(/^[0-9a-f]{64}$/)
    expect(selfCheckIdentity(request('GET', pass) as never)).toEqual({ ...identity, role: 'owner' })
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(selfCheckIdentity(request(method, pass) as never)).toBeNull()
    expect(selfCheckIdentity(request('GET', 'b'.repeat(64)) as never)).toBeNull()
    expect(selfCheckIdentity(request('GET', 'short') as never)).toBeNull()
    expect(selfCheckIdentity(request('GET') as never)).toBeNull()
    closeSelfCheckPass()
    expect(selfCheckIdentity(request('GET', pass) as never)).toBeNull()
    // Після проходу пропуск закрито, навіть якщо сторінки падали.
    const { app } = sampleApp()
    await runSelfCheck(app, identity)
    expect(selfCheckIdentity(request('GET', pass) as never)).toBeNull()
    const auth = readFileSync(new URL('../../middleware/auth.ts', import.meta.url), 'utf8')
    expect(auth.indexOf('selfCheckIdentity(req)')).toBeGreaterThan(0)
    expect(auth.indexOf('selfCheckIdentity(req)')).toBeLessThan(auth.indexOf("authHeader?.startsWith('Bearer ')"))
  })

  it('runs after every publication and every three hours, not on every knock of the scheduler', () => {
    const now = new Date('2026-11-22T18:00:00Z')
    expect(selfCheckDue(undefined, now, 'abc')).toBe(true)
    expect(selfCheckDue({ checked_at: null, commit: null }, now, 'abc')).toBe(true)
    expect(selfCheckDue({ checked_at: '2026-11-22T17:55:00Z', commit: 'abc' }, now, 'abc')).toBe(false)
    expect(selfCheckDue({ checked_at: '2026-11-22T17:55:00Z', commit: 'abc' }, now, 'def')).toBe(true)
    expect(selfCheckDue({ checked_at: new Date(now.getTime() - SELF_CHECK_EVERY_MS).toISOString(), commit: 'abc' }, now, 'abc')).toBe(true)
  })

  it('does nothing when it is not time, and only one of two simultaneous calls runs', async () => {
    query.mockResolvedValueOnce({ rows: [{ checked_at: new Date().toISOString(), commit: '' }] })
    await expect(runSelfCheckIfDue(sampleApp().app)).resolves.toEqual({ ran: false })
    expect(query).toHaveBeenCalledTimes(1)
    query.mockReset()
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rowCount: 0 })
    await expect(runSelfCheckIfDue(sampleApp().app)).resolves.toEqual({ ran: false })
    expect(query.mock.calls[1][0]).toContain('IS NOT DISTINCT FROM')
  })

  it('tells the owner once about failing pages and keeps the result for reading', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token'
    const sent: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).startsWith('https://api.telegram.org/')) { sent.push(JSON.parse(String(init?.body)).text); return new Response('{}', { status: 200 }) }
      return realFetch(url, init)
    }))
    query.mockResolvedValueOnce({ rows: [] })                                    // останній прохід
      .mockResolvedValueOnce({ rowCount: 1 })                                    // бронь
      .mockResolvedValueOnce({ rows: [{ tenant_id: 'shop-1', owner_telegram_chat_id: 42 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'owner-1', email: 'o@example.test' }] })
      .mockResolvedValueOnce({ rowCount: 1 })                                    // ключ тривоги новий
      .mockResolvedValueOnce({ rowCount: 1 })                                    // результат збережено
    const outcome = await runSelfCheckIfDue(sampleApp().app, new Date('2026-11-22T18:00:00Z'))
    expect(outcome.ran).toBe(true)
    expect(outcome.results?.[0].failures).toHaveLength(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('1 сторінка вебу відповідає помилкою')
    expect(sent[0]).toContain('/api/v1/salary/tire-service-report (INTERNAL_ERROR)')
    expect(String(query.mock.calls[4][1][1])).toMatch(/^self_check:2026-11-22:[0-9a-f]{16}$/)
    expect(query.mock.calls.at(-1)![0]).toContain('UPDATE server_self_check SET result')
    delete process.env.TELEGRAM_BOT_TOKEN
  })

  it('writes a short readable message', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ path: `/api/v1/page-${i}/${NIL}`, status: 500, code: null }))
    const text = selfCheckAlertText(many)
    expect(text).toContain('12 сторінок вебу відповідають помилкою')
    expect(text).toContain('• /api/v1/page-0/…')
    expect(text).toContain('…і ще 2')
    expect(text).not.toContain(NIL)
  })
})
const realFetch = globalThis.fetch
