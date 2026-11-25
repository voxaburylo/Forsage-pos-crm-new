import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query }, runTransaction: async (work: (client: { query: typeof query }) => unknown) => work({ query }) }))
import { applicabilityTree, detailsRows, fetchOfferDetails, omegaDetails } from '../supplierDetails.js'

// 25.11.2026 (власник: «усе, що можна витягнути по API, — витягуй»): опис товарів Омеги /product/details.
describe('supplier product details (Omega /product/details)', () => {
  beforeEach(() => query.mockReset())

  it('keeps OE numbers with the car model, specifications and the applicability tree; drops rows without an id', () => {
    const rows = detailsRows([
      { ProductId: -87748, OECodeList: [{ Code: '34 21 6 790 762', CarModel: 'BMW 3 (E90)' }, { Code: '34216790762', CarModel: 'BMW 3 (E90)' }, { Code: '' }],
        SpecificationList: [{ Key: 'Ширина, мм', Value: '42', Descr: null }, { Key: '', Value: '' }],
        ApplicabilityList: [{ Id: '1', Name: 'BMW', Children: [{ Name: '3 (E90)', Children: [{ Name: '320d' }] }] }, { Name: '' }] },
      { OECodeList: [] },
    ])
    expect(rows).toEqual([{ external_id: '-87748',
      oe_codes: [{ code: '34 21 6 790 762', code_key: '34216790762', car_model: 'BMW 3 (E90)' }],
      specifications: [{ key: 'Ширина, мм', value: '42', descr: null }],
      applicability: [{ name: 'BMW', children: [{ name: '3 (E90)', children: [{ name: '320d', children: [] }] }] }] }])
  })

  it('caps a huge applicability tree', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ Name: 'M' + i }))
    expect(applicabilityTree(many).length).toBe(2000)
  })

  it('asks Omega for a whole batch in one request', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ Success: true, Data: [] }), { status: 200 })) as unknown as typeof fetch
    await omegaDetails('KEY', ['1', '-2', 'x'], { fetchImpl })
    const [url, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, { body: string }]> } }).mock.calls[0]
    expect(url).toMatch(/\/product\/details$/)
    expect(JSON.parse(init.body)).toEqual({ ProductIdList: [1, -2], Key: 'KEY' })
  })

  it('does not call Omega when the shared request limit is used up', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const fetchImpl = vi.fn() as unknown as typeof fetch
    expect(await fetchOfferDetails({ id: 'c', tenant_id: 't', api_key: 'K' }, ['1'], { fetchImpl })).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
