import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
import { dbBusy, isDbBusy, DB_SLOW_PROBE_MS, DB_STUCK_QUERIES } from '../dbLoad.js'
import { OFFER_CHANGED_ONLY, syncConnectionStep } from '../supplierApiService.js'
import { SORT_PAGE, SORT_PAGES_PER_RUN } from '../supplierCategorySort.js'

// 27.11.2026: фонова робота вичерпала запас дискових операцій бази — сайт не міг забрати каталог, каса чекала хвилинами.
describe('background work steps aside when the database is busy', () => {
  beforeEach(() => query.mockReset())

  it('a slow answer or several stuck queries mean busy', () => {
    expect(isDbBusy(50, 0)).toBe(false)
    expect(isDbBusy(DB_SLOW_PROBE_MS + 1, 0)).toBe(true)
    expect(isDbBusy(50, DB_STUCK_QUERIES)).toBe(true)
    expect(isDbBusy(50, DB_STUCK_QUERIES - 1)).toBe(false)
  })

  it('asks the database itself; no answer counts as busy', async () => {
    query.mockResolvedValueOnce({ rows: [{ stuck: 0 }] })
    expect(await dbBusy(() => 1_000)).toBe(false)
    query.mockResolvedValueOnce({ rows: [{ stuck: 4 }] })
    expect(await dbBusy(() => 1_000)).toBe(true)
    let clock = 0
    query.mockResolvedValueOnce({ rows: [{ stuck: 0 }] })
    expect(await dbBusy(() => (clock += 900))).toBe(true)
    query.mockRejectedValueOnce(new Error('timeout'))
    expect(await dbBusy()).toBe(true)
  })

  it('the scheduler skips price lists, site texts and the category sort when busy, never site orders', () => {
    const route = readFileSync(new URL('../../routes/internalAi.ts', import.meta.url), 'utf8')
    expect(route).toContain("if (await dbBusy()) { res.json({ data: { skipped: 'db_busy' } }); return }")
    expect(route).toContain('busy ? Promise.resolve(skipped) : import(\'../services/siteTextJobService.js\')')
    expect(route).toContain('busy ? Promise.resolve(skipped) : import(\'../services/supplierCategorySort.js\')')
    expect(route).toContain("import('../services/siteOrderPull.js').then(module => module.runSiteOrderPullStep())")
    expect(route).not.toContain('busy ? Promise.resolve(skipped) : import(\'../services/siteOrderPull.js\')')
  })
})

describe('a price-list pass does not rewrite goods that did not change', () => {
  beforeEach(() => query.mockReset())

  it('the row is written only when something the supplier sent differs', () => {
    for (const column of ['number', 'brand', 'name', 'barcode', 'purchase_price', 'retail_price', 'stock', 'total_qty']) {
      expect(OFFER_CHANGED_ONLY).toContain(`supplier_offers.${column} IS DISTINCT FROM EXCLUDED.${column}`)
    }
    // Позначка часу сама по собі — не причина переписувати рядок.
    expect(OFFER_CHANGED_ONLY).not.toContain('seen_at')
    expect(OFFER_CHANGED_ONLY.trimStart().startsWith('WHERE')).toBe(true)
  })

  it('"seen in this pass" goes to the narrow table, and only what was not seen there is zeroed', async () => {
    query.mockImplementation(async (sql: string) => ({ rows: /calls_hour_count/.test(String(sql)) ? [{ id: 'c' }] : [] }))
    const item = { ProductId: -1, Card: '1', Number: 'S-7 s', BrandDescription: 'Bosch', Description: 'Свічка', DescriptionUkr: 'Свічка запалювання s', Price: 100, Rests: [{ Key: 'Львів 1', Value: '2' }] }
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) =>
      new Response(JSON.stringify({ Result: JSON.parse(String(init.body)).From === 1 ? [item] : [], Total: 1 }), { status: 200 })) as unknown as typeof fetch
    await syncConnectionStep({ id: 'c', tenant_id: 't', api_key: 'K', sync_page: 1, sync_started_at: null, last_full_sync_at: null }, { fetchImpl })
    const calls = query.mock.calls.map(call => ({ sql: String(call[0]), params: call[1] as unknown[] }))
    const upsert = calls.find(call => call.sql.includes('INSERT INTO supplier_offers'))!
    expect(upsert.sql).toContain(OFFER_CHANGED_ONLY)
    const seen = calls.find(call => call.sql.includes('INSERT INTO supplier_offer_seen'))!
    expect(seen.params).toEqual(['c', ['-1']])
    expect(seen.sql).toContain('ON CONFLICT (connection_id, external_id) DO UPDATE SET seen_at = now()')
    const zero = calls.find(call => call.sql.includes("stock = '[]'::jsonb, total_qty = 0"))!
    expect(zero.sql).toContain('NOT EXISTS (SELECT 1 FROM supplier_offer_seen s')
    expect(zero.sql).toContain('s.seen_at >= $2')
  })
})

describe('the category sort is gentle', () => {
  it('no more than 300 goods a minute', () => {
    expect(SORT_PAGE * SORT_PAGES_PER_RUN).toBeLessThanOrEqual(300)
  })
})
