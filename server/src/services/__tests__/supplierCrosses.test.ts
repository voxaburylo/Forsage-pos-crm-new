import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query }, runTransaction: async (work: (client: { query: typeof query }) => unknown) => work({ query }) }))
import { crossRows, fetchOfferCrosses, omegaCrosses, searchCrosses, sortCrosses } from '../supplierCrosses.js'

const json = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch

// 25.11.2026 (власник: «хочу використовувати крос-номери Омеги для підбору аналогів — там велика база»).
describe('supplier cross numbers (Omega /product/getAllCrosses)', () => {
  beforeEach(() => query.mockReset())

  it('cleans the answer: normalized code, no empty codes, no repeats', () => {
    expect(crossRows([
      { ProductId: 1, Code: '0 986 452 041', Brand: 'Bosch', ReplacementType: 'Аналог' },
      { Code: '0986452041', Brand: 'BOSCH' },
      { Code: '', Brand: 'X' },
      { Code: 'W 712/75', Brand: '' },
    ])).toEqual([
      { code: '0 986 452 041', code_key: '0986452041', brand: 'Bosch', replacement_type: 'Аналог' },
      { code: 'W 712/75', code_key: 'W71275', brand: '', replacement_type: null },
    ])
    expect(crossRows(null)).toEqual([])
  })

  it('asks Omega with the numeric product id, negative ids included; never with a non-number', async () => {
    const fetchImpl = json({ Success: true, Data: [{ Code: 'OC90', Brand: 'Knecht' }] })
    expect(await omegaCrosses('KEY', '-87748', { fetchImpl })).toEqual([{ code: 'OC90', code_key: 'OC90', brand: 'Knecht', replacement_type: null }])
    const body = JSON.parse(String((fetchImpl as unknown as { mock: { calls: Array<[string, { body: string }]> } }).mock.calls[0][1].body))
    expect(body).toEqual({ ProductId: -87748, Key: 'KEY' })
    expect(String((fetchImpl as unknown as { mock: { calls: Array<[string]> } }).mock.calls[0][0])).toMatch(/\/product\/getAllCrosses$/)
    expect(await omegaCrosses('KEY', 'abc', { fetchImpl })).toEqual([])
  })

  it('does not call Omega when the shared request limit is used up', async () => {
    query.mockResolvedValueOnce({ rows: [] }) // takeCall: ліміт вичерпано
    const fetchImpl = json({ Data: [] })
    expect(await fetchOfferCrosses({ id: 'c', tenant_id: 't', api_key: 'K' }, '1', { fetchImpl })).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('lists first what we have in stock, then what Omega has, then bare codes', () => {
    const row = (code: string, ours: number[], supplier: number) => ({ code, ours: ours.map(qty => ({ qty_on_hand: qty })), supplier: Array(supplier).fill({}) })
    expect(sortCrosses([row('C', [], 0), row('B', [], 1), row('A', [0], 0), row('D', [2], 0)]).map(r => r.code)).toEqual(['D', 'B', 'A', 'C'])
  })

  it('a short query asks nothing', async () => {
    expect(await searchCrosses('t', 'ab', true)).toEqual({ query: 'AB', crosses: [], pending: false })
    expect(query).not.toHaveBeenCalled()
  })

  it('the scheduler fetches crosses for our cards between the price list and photos; the till relays the search', () => {
    const service = readFileSync(new URL('../supplierApiService.ts', import.meta.url), 'utf8')
    expect(service.indexOf('syncCrossesStep(row, deps)')).toBeGreaterThan(service.indexOf('syncConnectionStep({ ...row'))
    expect(service.indexOf('syncCrossesStep(row, deps)')).toBeLessThan(service.indexOf('syncPhotosStep(row, deps)'))
    const till = readFileSync(new URL('../../../../apps/desktop/src/link/tillDeviceLink.ts', import.meta.url), 'utf8')
    expect(till).toContain('supplier-offers\\/(?:search|crosses|details)')
  })
})

describe('crosses for our cards (main PC writes them into card cross numbers)', () => {
  beforeEach(() => query.mockReset())
  it('merges Omega crosses and OE numbers per card without repeats, with a resume marker', async () => {
    const { linkedOfferCrossNumbers } = await import('../supplierCrosses.js')
    query.mockResolvedValueOnce({ rows: [{ product_id: 'p1', found_at: '2026-11-25T20:00:00Z',
      crosses: [{ code: 'OC 90', brand: 'Knecht' }, { code: 'W712/75', brand: null }], oe: ['OC90', '15400-PLM-A01', 'X'] }] })
    expect(await linkedOfferCrossNumbers('t', null)).toEqual([{ program_product_id: 'p1', found_at: '2026-11-25T20:00:00.000Z',
      numbers: [{ number: 'OC 90', brand: 'Knecht' }, { number: 'W712/75', brand: null }, { number: '15400-PLM-A01', brand: null }] }])
    expect(String(query.mock.calls[0][0])).toContain('o.product_id IS NOT NULL')
  })
})
