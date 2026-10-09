import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ pull: vi.fn(), bootstrap: vi.fn(), push: vi.fn(), log: vi.fn() }))
vi.mock('../services/syncService.js', () => ({
  getSyncChanges: calls.pull, getBootstrapSnapshot: calls.bootstrap, pushLocalOperations: calls.push,
}))
vi.mock('../lib/logger.js', () => ({ logger: { error: calls.log } }))
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const role = req.headers['x-test-role']
    if (!role) return res.status(401).json({ error: 'not authorized' })
    req.user = { id: 'staff', tenant_id: 'shop', role }; next()
  },
  requireRole: (...roles: string[]) => (req: any, res: any, next: any) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'forbidden' }),
}))
import router from './sync.js'
import { errorHandler } from '../middleware/errorHandler.js'
let server: Server, url: string
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/sync', router); app.use(errorHandler)
  server = createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/sync'
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
})
beforeEach(() => {
  vi.clearAllMocks()
  calls.pull.mockResolvedValue({ cursor: '2026-10-09T10:00:00Z', products: [] })
  calls.bootstrap.mockResolvedValue({ exported_at: '2026-10-09T10:00:00Z', products: [] })
})
it.each(['changes','bootstrap'])('streams the existing %s endpoint with the same envelope', async endpoint => {
  const response = await fetch(url + '/' + endpoint, { headers: { 'x-test-role': 'owner' } })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-length')).toBeNull()
  expect(response.headers.get('cache-control')).toContain('private')
  expect((await response.json()).data.products).toEqual([])
})
it('retains request scope, filters and tenant from authentication', async () => {
  await fetch(url + '/changes?since=2026-10-01T00:00:00Z&include_references=true&reset_generation=2',
    { headers: { 'x-test-role': 'owner' } }).then(r => r.text())
  expect(calls.pull).toHaveBeenCalledWith({ since: '2026-10-01T00:00:00Z', tenantId: 'shop', userId: 'staff',
    role: 'owner', includeReferences: true, resetGeneration: 2 })
})
it.each(['changes','bootstrap'])('does not read %s data for unauthenticated requests', async endpoint => {
  expect((await fetch(url + '/' + endpoint)).status).toBe(401)
  expect(calls.pull).not.toHaveBeenCalled(); expect(calls.bootstrap).not.toHaveBeenCalled()
})
it('does not let a cashier bootstrap all data', async () => {
  expect((await fetch(url + '/bootstrap', { headers: { 'x-test-role': 'cashier' } })).status).toBe(403)
  expect(calls.bootstrap).not.toHaveBeenCalled()
})
it('keeps validation errors as normal 400 JSON, without requesting data', async () => {
  const response = await fetch(url + '/changes?since=bad', { headers: { 'x-test-role': 'owner' } })
  expect(response.status).toBe(400)
  expect((await response.json()).error.code).toBe('VALIDATION_ERROR')
  expect(calls.pull).not.toHaveBeenCalled()
})
it('keeps service errors before streaming as ordinary API errors', async () => {
  calls.pull.mockRejectedValue(new Error('failure'))
  const response = await fetch(url + '/changes', { headers: { 'x-test-role': 'owner' } })
  expect(response.status).toBe(500)
  expect((await response.json()).error.code).toBe('INTERNAL_ERROR')
})
it('does not append an error response after the stream has started', async () => {
  calls.pull.mockResolvedValue({ products: Array.from({length: 3000}, () => ({name: 'Товар '.repeat(30)})), bad: BigInt(1) })
  const response = await fetch(url + '/changes', { headers: { 'x-test-role': 'owner' } })
  expect(response.status).toBe(200)
  await expect(response.json()).rejects.toThrow()
  await vi.waitFor(() => expect(calls.log).toHaveBeenCalledWith(expect.anything(), 'Response interrupted'))
})
