import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { syncFunctionBody } from './helpers/syncSource.js'
const calls = vi.hoisted(() => ({ fetch: vi.fn(), from: vi.fn(), query: [] as any[] }))
vi.mock('../../db/supabase.js', () => ({ db: { from: calls.from } }))
vi.mock('../syncKeyset.js', () => ({ fetchAllByTimestamp: calls.fetch }))
vi.mock('../sync/syncCore.js', () => ({ IN_FILTER_CHUNK: 80, isUuid: (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) }))
import { includeHistoricalProductParents } from '../sync/historicalProductParents.js'
const tenant = randomUUID(), otherTenant = randomUUID(), at = '2026-10-13T00:00:00.000Z'
const archived = (id = randomUUID()) => ({ id, tenant_id: tenant, deleted_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z', sku: 'ARCHIVED', name: 'Old part', qty_on_hand: 0, purchase_price: 500 })
beforeEach(() => {
  vi.clearAllMocks(); calls.query = []
  calls.from.mockImplementation(table => {
    const steps: any[] = [['from', table]]; calls.query.push(steps)
    const q: any = { steps }
    for (const method of ['select', 'eq', 'in', 'not', 'is', 'or', 'gte']) q[method] = (...args: any[]) => { steps.push([method, ...args]); return q }
    return q
  })
  calls.fetch.mockImplementation(async build => { build(); return [] })
})
describe('bootstrap historical product parents', () => {
  it('does not fetch or mutate an already complete catalog', async () => {
    const p = archived(); const rows = [p]
    expect(await includeHistoricalProductParents(tenant, rows, [[{ product_id: p.id }, { product_id: null }]], at)).toEqual(rows)
    expect(calls.fetch).not.toHaveBeenCalled()
  })
  it('retains the exact tombstone with tenant, identity and cutoff constraints', async () => {
    const p = archived()
    calls.fetch.mockImplementation(async build => { build(); return [p] })
    expect(await includeHistoricalProductParents(tenant, [], [[{ product_id: p.id }]], at)).toEqual([p])
    expect(calls.query[0]).toContainEqual(['eq', 'tenant_id', tenant])
    expect(calls.query[0]).toContainEqual(['in', 'id', [p.id]])
    expect(calls.query[0]).toContainEqual(['not', 'deleted_at', 'is', null])
    expect(calls.fetch.mock.calls[0][1]).toEqual({ timestampColumn: 'updated_at', upperBound: at })
  })
  it.each(['missing', 'foreign', 'active', 'unexpected', 'duplicate'])('rejects %s evidence instead of acknowledging a partial snapshot', async kind => {
    const p = archived(), returned = kind === 'missing' ? [] : kind === 'foreign' ? [{ ...p, tenant_id: otherTenant }]
      : kind === 'active' ? [{ ...p, deleted_at: null }] : kind === 'unexpected' ? [archived()] : [p, p]
    calls.fetch.mockResolvedValue(returned)
    await expect(includeHistoricalProductParents(tenant, [], [[{ product_id: p.id }]], at)).rejects.toMatchObject({ code: 'SYNC_HISTORY_INCOMPLETE' })
  })
  it('deduplicates document references and bounds each URL ID list', async () => {
    const rows = Array.from({ length: 161 }, () => archived())
    calls.fetch.mockImplementation(async build => {
      build(); const ids = calls.query.at(-1)?.find((step: any[]) => step[0] === 'in')[2]
      return rows.filter(row => ids.includes(row.id))
    })
    const documents = rows.map(row => ({ product_id: row.id }))
    expect(await includeHistoricalProductParents(tenant, [], [documents, documents], at)).toEqual(rows)
    expect(calls.query.map(steps => steps.find((s: any[]) => s[0] === 'in')[2].length)).toEqual([80, 80, 1])
  })
  it('rejects an invalid reference without sending a query', async () => {
    await expect(includeHistoricalProductParents(tenant, [], [[{ product_id: 'invalid' }]], at)).rejects.toThrow()
    expect(calls.fetch).not.toHaveBeenCalled()
  })
  it.each([true, false])('executes the actual bootstrap assembly; archived parent present=%s', async present => {
    const p = archived(), active = { ...archived(), deleted_at: null }, sale = { product_id: p.id }
    calls.fetch.mockImplementation(async build => {
      const q = build(), table = q.steps[0][1]
      if (table === 'products') return q.steps.some((s: any[]) => s[0] === 'not') ? (present ? [p] : []) : [active]
      if (table === 'sale_items') return [sale]
      return []
    })
    const source = ts.transpileModule(syncFunctionBody('getBootstrapSnapshot').replace(/^export /, ''),
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const bootstrap = runInNewContext(source + '\ngetBootstrapSnapshot', {
      db: { from: calls.from }, fetchAllByTimestamp: calls.fetch, includeHistoricalProductParents,
      captureSyncState: async () => ({ cursor: at, generation: 1, resetAt: null }), listUsers: async () => [],
      fetchSupplierCatalogCopy: async () => ({ data: { supplier_price_items: [], supplier_price_imports: [] }, parents: [] }),
      mergeCatalogSupplierParents: (a: any[], b: any[]) => [...a, ...b], fetchShopSettings: async () => ({}),
      fetchSecondarySyncData: async () => ({ staff_pins: [], customer_return_items: [], writeoff_items: [], stock_reserves: [], warehouse_movements: [] }),
    })
    if (present) {
      const result = await bootstrap(tenant)
      expect(result.products).toEqual([active, p])
      expect(result.counts.products).toBe(2)
      expect(result.sale_items).toEqual([{ ...sale, sale: undefined }])
      expect(result.exported_at).toBe(at)
    } else await expect(bootstrap(tenant)).rejects.toMatchObject({ code: 'SYNC_HISTORY_INCOMPLETE' })
    expect(syncFunctionBody('getSyncChanges')).not.toContain('includeHistoricalProductParents')
  })
})
