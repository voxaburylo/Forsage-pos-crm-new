import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
import { code, omegaOffer, restQty, saveConnection, searchOffers, syncConnectionStep, warehouseCity } from '../supplierApiService.js'
import { isWriteAllowed } from '../../middleware/localFirstWriteGuard.js'

const omegaItem = (over: Record<string, unknown> = {}) => ({ ProductId: -87748, Card: '69351412', Number: '36489', BrandDescription: 'A.B.S.',
  Description: 'Колодка', DescriptionUkr: 'Колодка гальм. диск. BMW 3 задн.', Price: 367.02,
  Rests: [{ Key: 'Львів 1', Value: '1' }, { Key: 'Харків 1', Value: '>10' }, { Key: 'Київ 6', Value: '0' }], ...over })
const json = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

// 24.11.2026 (слово власника): постачальник Омега за ключем API — товари під замовлення, не на склад магазину.
describe('Omega supplier', () => {
  beforeEach(() => query.mockReset())

  it('turns a price-list row into an offer: kopecks, stock per warehouse, retail by the grid, never below purchase', () => {
    const offer = omegaOffer(omegaItem(), purchase => Math.round(purchase * 1.3))
    expect(offer).toMatchObject({ external_id: '-87748', number: '36489', number_code: '36489', brand: 'A.B.S.', name: 'Колодка гальм. диск. BMW 3 задн.',
      purchase_price: 36702, retail_price: 47713, total_qty: 11, stock: [{ w: 'Львів 1', q: 1 }, { w: 'Харків 1', q: 10 }] })
    expect(omegaOffer(omegaItem({ Number: '' }), p => p)).toBeNull()
    expect(omegaOffer(omegaItem({ Price: 0 }), p => p)).toBeNull()
    expect(omegaOffer(omegaItem({ ImageUrl: 'http://x/a.jpg' }), p => p)?.image_url).toBeNull()
    expect([restQty('1'), restQty('>10'), restQty('10+'), restQty('4,000'), restQty(''), restQty(null)]).toEqual([1, 10, 10, 4, 0, 0])
    expect([code('KCF-8113-C'), code(' 0 986 452 041 ')]).toEqual(['KCF8113C', '0986452041'])
    expect([warehouseCity('Львів 1'), warehouseCity('Київ_Правий_Південь')]).toEqual(['Львів', 'Київ'])
  })

  it('checks the key with Omega before saving; a wrong key never replaces a working one', async () => {
    await expect(saveConnection('t', 'u', { provider: 'omega', name: 'Омега', enabled: true, api_key: 'WRONGKEY1' },
      { fetchImpl: json({ Success: false, Errors: [{ Description: 'Invalid key' }] }) })).rejects.toThrow('Омега відмовила: Invalid key')
    expect(query).not.toHaveBeenCalled()
  })

  it('a step takes pages until the end, zeroes what disappeared and links to our cards; waits an hour between passes', async () => {
    query.mockResolvedValue({ rows: [] })
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const from = JSON.parse(String(init.body)).From
      return new Response(JSON.stringify({ Result: from === 1 ? [omegaItem()] : [], Total: 1 }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await syncConnectionStep({ id: 'c', tenant_id: 't', api_key: 'K', sync_page: 1, sync_started_at: null, last_full_sync_at: null }, { fetchImpl })
    expect(result).toMatchObject({ ran: true, done: true, fetched: 1 })
    const sql = query.mock.calls.map(call => String(call[0]))
    expect(sql.some(text => text.includes('INSERT INTO supplier_offers'))).toBe(true)
    expect(sql.some(text => text.includes("stock = '[]'::jsonb, total_qty = 0"))).toBe(true)
    expect(sql.some(text => text.includes('UPDATE supplier_offers o SET product_id'))).toBe(true)
    expect(sql.some(text => text.includes('INSERT INTO products'))).toBe(false)
    expect((await syncConnectionStep({ id: 'c', tenant_id: 't', api_key: 'K', sync_page: 1, sync_started_at: null, last_full_sync_at: new Date().toISOString() }, { fetchImpl })).ran).toBe(false)
  })

  it('search shows purchase only to those allowed; short queries are not searched', async () => {
    expect(await searchOffers('t', 'ab', true)).toEqual([])
    const row = { connection_id: 'c', supplier: 'Омега', supplier_id: null, external_id: '1', number: '36489', brand: 'ABS', name: 'Колодка', image_url: null,
      purchase_price: 36702, retail_price: 47713, stock: [{ w: 'Львів 1', q: 2 }, { w: 'Київ 6', q: 5 }], total_qty: 7, product_id: null, updated_at: '2026-11-24T10:00:00Z' }
    query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ connection_id: 'c', code: 'Львів 1', name: 'Львів 1', city: 'Львів', days_to_ship: 3, is_active: true },
      { connection_id: 'c', code: 'Київ 6', name: 'Київ 6', city: 'Київ', days_to_ship: 5, is_active: false }] })
    const [found] = await searchOffers('t', '36-489', false)
    expect(found).not.toHaveProperty('purchase_price')
    expect(found.stock).toEqual([{ warehouse: 'Львів 1', city: 'Львів', qty: 2, days_to_ship: 3, active: true }])
    expect(query.mock.calls[0][1]).toEqual(['t', '36489'])
  })

  it('the owner may save supplier keys from the web; nothing else opens', () => {
    const request = (method: string, path: string) => ({ method, path, get: () => undefined }) as never
    expect(isWriteAllowed(request('PUT', '/api/v1/supplier-api'))).toBe(true)
    expect(isWriteAllowed(request('PUT', '/api/v1/supplier-apix'))).toBe(false)
  })
})
