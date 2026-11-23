import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/pg.js', () => ({ pool: { query: vi.fn() } }))
vi.mock('../syncService.js', () => ({ pushLocalOperations: vi.fn() }))

import { pushFromMainPc } from '../tillDevicePush.js'

const tenant = '11111111-1111-4111-8111-111111111111'
const device = { tenant_id: tenant, device_id: 'pc-1', created_by: 'owner-1' }
const operation = (id: string, type: string, sequence: number) => ({
  sequence, operation_id: id, tenant_id: tenant, device_id: 'pc-1', aggregate_type: 'order', aggregate_id: 'a-' + id,
  operation_type: type, payload: { customer_phone: '+380671234567' }, created_at: '2026-11-23T10:00:00.000+00:00',
})

// 23.11.2026 (план T3): документ каси, який сервер не прийняв, видно на екрані «Стан системи».
describe('a document the server refused is written to the error log', () => {
  it('only failed documents are reported: the kind of document and the technical text, never its content', async () => {
    const push = vi.fn(async () => ({
      results: [
        { sequence: 1, operation_id: 'op-1', aggregate_id: 'a-op-1', status: 'synced' as const },
        { sequence: 2, operation_id: 'op-2', aggregate_id: 'a-op-2', status: 'failed' as const, error: 'FOR UPDATE is not allowed with GROUP BY clause' },
      ],
      reset_required: false, reset_generation: 0, reset_at: null,
    }))
    const report = vi.fn(async () => 'inserted' as const)
    const answer = await pushFromMainPc(device, { reset_generation: 0, operations: [operation('op-1', 'settings.updated', 1), operation('op-2', 'order.deleted', 2)] }, push as never, report as never)
    // Відповідь касі не змінюється: запис помилки — довідка для власника.
    expect(answer.results).toHaveLength(2)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith({ tenantId: tenant, source: 'sync', route: 'order.deleted', message: 'FOR UPDATE is not allowed with GROUP BY clause' })
    expect(JSON.stringify(report.mock.calls)).not.toContain('380671234567')
  })

  it('nothing is reported when everything was accepted', async () => {
    const push = vi.fn(async () => ({ results: [{ sequence: 1, operation_id: 'op-1', aggregate_id: 'a', status: 'synced' as const }], reset_required: false, reset_generation: 0, reset_at: null }))
    const report = vi.fn(async () => 'inserted' as const)
    await pushFromMainPc(device, { reset_generation: 0, operations: [operation('op-1', 'settings.updated', 1)] }, push as never, report as never)
    expect(report).not.toHaveBeenCalled()
  })

  it('an unexpected server error is recorded by the error handler, but a database outage is not (the log lives in that database)', () => {
    const handler = readFileSync(new URL('../../middleware/errorHandler.ts', import.meta.url), 'utf8')
    expect(handler).toContain("rememberError(req, 500, 'INTERNAL_ERROR', err)")
    expect(handler.match(/rememberError\(req, /g)).toHaveLength(1)
    expect(handler).toContain('service.safeRoute(req.method, req.originalUrl ?? req.url)')
    // Очікувані відмови (AppError: немає прав, не знайдено) у журнал помилок не йдуть.
    expect(handler.indexOf('if (err instanceof AppError)')).toBeLessThan(handler.indexOf("rememberError(req, 500"))
  })

  it('the status screen is read by the owner and the administrator only', () => {
    const route = readFileSync(new URL('../../routes/system.ts', import.meta.url), 'utf8')
    expect(route).toContain("systemRouter.get('/status', requireRole('owner', 'admin')")
    expect(readFileSync(new URL('../../index.ts', import.meta.url), 'utf8')).toContain("app.use('/api/v1/system', systemRouter)")
  })
})
