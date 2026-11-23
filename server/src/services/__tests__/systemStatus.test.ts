import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/pg.js', () => ({ pool: { query: vi.fn() } }))

import { errorRepeatKey, forgetServerErrors, readStatusReport, recordServerError, safeErrorText, safeRoute, tillOnline } from '../systemStatusService.js'

// 23.11.2026 (план T2 і T3): стан системи для власника і помилки сервера в базі.
describe('till status report (T2)', () => {
  const good = {
    version: '0.1.0', release_id: '20261123T113640-dc2cc67e', built_at: '2026-11-23T11:36:40.000Z', mode: 'background', role: 'main',
    disk_free_bytes: 1000, disk_total_bytes: 5000, database_bytes: 300, local_backup_at: '2026-11-23T09:00:00.000Z',
    cloud_backup_at: '2026-11-23T08:00:00.000Z', external_backup_at: null, schema_version: 28, started_at: '2026-11-23T07:00:00.000Z',
    check_at: '2026-11-23T03:00:00.000Z', check_findings: [{ code: 'nightly-stock-ledger', title: 'Залишок не збігається з рухом товару', count: 274 }],
    manager_release_id: '20261120T100000-aaaa', manager_seen_at: '2026-11-23T11:50:00.000Z',
  }

  it('accepts the known shape as is', () => {
    expect(readStatusReport(good)).toEqual(good)
  })

  it('drops everything it does not know and turns wrong values into «unknown», never into numbers', () => {
    const report = readStatusReport({ ...good, extra: 'x', customers: [{ phone: '+380671234567' }], disk_free_bytes: -5, database_bytes: 'big', cloud_backup_at: 'yesterday', schema_version: 0, version: 'v'.repeat(500) })!
    expect(Object.keys(report).sort()).toEqual(Object.keys(good).sort())
    expect(report.disk_free_bytes).toBeNull()
    expect(report.database_bytes).toBeNull()
    expect(report.cloud_backup_at).toBeNull()
    expect(report.schema_version).toBeNull()
    expect(report.version).toHaveLength(40)
    expect(readStatusReport({ ...good, disk_free_bytes: null }))?.toMatchObject({ disk_free_bytes: null })
  })

  it('refuses a report without a known mode or role, and anything that is not an object', () => {
    for (const bad of [null, undefined, 'text', 5, [], { ...good, mode: 'hidden' }, { ...good, role: 'server' }, {}]) expect(readStatusReport(bad)).toBeNull()
  })

  it('the till is «on link» only while it answered within two minutes', () => {
    const now = Date.parse('2026-11-23T12:00:00.000Z')
    expect(tillOnline('2026-11-23T11:59:10.000Z', now)).toEqual({ online: true, offline_minutes: 0 })
    expect(tillOnline('2026-11-23T11:30:00.000Z', now)).toEqual({ online: false, offline_minutes: 30 })
    expect(tillOnline(null, now)).toEqual({ online: false, offline_minutes: null })
    expect(tillOnline('garbage', now)).toEqual({ online: false, offline_minutes: null })
  })
})

describe('server errors go to the database (T3)', () => {
  beforeEach(() => forgetServerErrors())

  it('the address is stored without parameters and without ids, phones or long tokens', () => {
    expect(safeRoute('post', '/api/v1/orders/3f2c9a1e-0000-4000-8000-000000000001/payments?token=secret')).toBe('POST /api/v1/orders/:id/payments')
    expect(safeRoute('GET', '/api/v1/customers/by-phone/+380671234567')).toBe('GET /api/v1/customers/by-phone/:n')
    expect(safeRoute('GET', '/api/v1/price-list/' + 'a'.repeat(64))).toBe('GET /api/v1/price-list/:long')
    expect(safeRoute(undefined, '/api/v1/health#x')).toBe('/api/v1/health')
    expect(safeRoute('GET', undefined)).toBeNull()
  })

  it('the text keeps the technical part and loses what looks like personal data or keys', () => {
    expect(safeErrorText('FOR UPDATE is not allowed with GROUP BY clause')).toBe('FOR UPDATE is not allowed with GROUP BY clause')
    const cleaned = safeErrorText('duplicate key for ivan@example.com phone +380 67 123 45 67 key ' + 'sk-' + 'x'.repeat(24))
    expect(cleaned).not.toContain('ivan@example.com')
    expect(cleaned).not.toContain('123 45 67')
    expect(cleaned).not.toContain('sk-x')
    expect(cleaned).toContain('duplicate key')
    expect(safeErrorText('x'.repeat(2000)).length).toBeLessThanOrEqual(500)
    expect(safeErrorText(undefined)).toBe('unknown error')
    expect(safeErrorText('  ')).toBe('unknown error')
  })

  it('the first error is inserted; the same one within ten minutes only raises the counter', async () => {
    let now = 1_000_000
    const query = vi.fn(async () => ({ rowCount: 1 }))
    const error = { tenantId: 't1', source: 'request' as const, route: 'POST /api/v1/sync/push', status: 500, code: '0A000', message: 'FOR UPDATE is not allowed with GROUP BY clause' }
    expect(await recordServerError(error, query, () => now)).toBe('inserted')
    expect(query.mock.calls[0][0]).toContain('INSERT INTO server_errors')
    expect(query.mock.calls[0][1]).toEqual(['t1', 'request', 'POST /api/v1/sync/push', 500, '0A000', 'FOR UPDATE is not allowed with GROUP BY clause'])
    now += 60_000
    expect(await recordServerError(error, query, () => now)).toBe('repeated')
    expect(query.mock.calls.at(-1)![0]).toContain('SET repeats = repeats + 1')
    // Інша помилка чи інший магазин — окремий запис.
    expect(await recordServerError({ ...error, message: 'another failure' }, query, () => now)).toBe('inserted')
    expect(await recordServerError({ ...error, tenantId: 't2' }, query, () => now)).toBe('inserted')
    now += 11 * 60_000
    expect(await recordServerError(error, query, () => now)).toBe('inserted')
    expect(errorRepeatKey(error)).not.toBe(errorRepeatKey({ ...error, route: 'GET /x' }))
  })

  it('writing an error never throws and never becomes a second error', async () => {
    const broken = vi.fn(async () => { throw new Error('relation "server_errors" does not exist') })
    await expect(recordServerError({ source: 'job', message: 'boom' }, broken)).resolves.toBe('failed')
  })

  it('old rows are cleaned by the same path, rarely', async () => {
    let now = 5_000_000_000
    const query = vi.fn(async () => ({ rowCount: 1 }))
    await recordServerError({ source: 'job', message: 'first' }, query, () => now)
    expect(query.mock.calls.some(call => String(call[0]).includes("interval '30 days'"))).toBe(true)
    query.mockClear(); now += 60_000
    await recordServerError({ source: 'job', message: 'second' }, query, () => now)
    expect(query.mock.calls.some(call => String(call[0]).includes("interval '30 days'"))).toBe(false)
  })
})
