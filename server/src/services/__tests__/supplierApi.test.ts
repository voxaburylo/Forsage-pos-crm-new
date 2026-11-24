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
    // Лічильник запитів дає дозвіл; решта запитів до бази порожні.
    query.mockImplementation(async (sql: string) => ({ rows: /calls_hour_count/.test(String(sql)) ? [{ id: 'c' }] : [] }))
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

// 24.11.2026 (власник: «нехай вантажить фото Омеги, там не більше 300 на годину»).
describe('Omega photos and the request limit', () => {
  beforeEach(() => query.mockReset())
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)])
  const image = (body: Buffer | string, type: string, status = 200) => vi.fn(async () => new Response(body, { status, headers: { 'content-type': type } })) as unknown as typeof fetch

  it('keeps a margin under Omega limits and counts every request in the database', async () => {
    const { CALLS_PER_HOUR, CALLS_PER_MINUTE, PHOTOS_PER_RUN, PAGES_PER_RUN, takeCall } = await import('../supplierApiService.js')
    expect(CALLS_PER_HOUR).toBeLessThanOrEqual(270); expect(CALLS_PER_MINUTE).toBeLessThanOrEqual(25)
    // Найгірша година: 12 викликів планувальника — усе одно не більше дозволеного лічильником.
    expect(12 * PHOTOS_PER_RUN + 80).toBeLessThan(300); expect(PAGES_PER_RUN + PHOTOS_PER_RUN).toBeLessThan(30)
    query.mockResolvedValueOnce({ rows: [{ id: 'c' }] }).mockResolvedValueOnce({ rows: [] })
    expect(await takeCall('c')).toBe(true); expect(await takeCall('c')).toBe(false)
    expect(query.mock.calls[0][1]).toEqual(['c', CALLS_PER_HOUR, CALLS_PER_MINUTE])
  })

  it('takes only a real picture; anything else means "no photo"', async () => {
    const { omegaImage } = await import('../supplierApiService.js')
    expect(await omegaImage('K', '-87748', { fetchImpl: image(jpeg, 'image/jpeg') })).toMatchObject({ type: 'image/jpeg' })
    expect(await omegaImage('K', '-87748', { fetchImpl: image('{"Success":false}', 'application/json') })).toBeNull()
    expect(await omegaImage('K', '-87748', { fetchImpl: image(Buffer.alloc(3000, 7), 'image/jpeg') })).toBeNull()
    expect(await omegaImage('K', '-87748', { fetchImpl: image(jpeg, 'image/jpeg', 404) })).toBeNull()
    expect(await omegaImage('K', 'abc; drop', { fetchImpl: image(jpeg, 'image/jpeg') })).toBeNull()
    await expect(omegaImage('K', '1', { fetchImpl: image('', 'text/plain', 429) })).rejects.toMatchObject({ code: 'SUPPLIER_LIMIT' })
  })

  it('stops as soon as the counter says enough, remembers goods without a photo, saves the rest', async () => {
    const { syncPhotosStep } = await import('../supplierApiService.js')
    const upload = vi.fn(async (path: string) => 'https://x.supabase.co/storage/v1/object/public/supplier-photos/' + path)
    let allowed = 2
    query.mockImplementation(async (sql: string) => {
      if (/count\(\*\)::int AS n/.test(sql)) return { rows: [{ n: 0 }] }
      if (/SELECT external_id FROM supplier_offers/.test(sql)) return { rows: [{ external_id: '-1' }, { external_id: '-2' }, { external_id: '-3' }] }
      if (/calls_hour_count/.test(sql)) return { rows: allowed-- > 0 ? [{ id: 'c' }] : [] }
      return { rows: [] }
    })
    let n = 0
    const fetchImpl = vi.fn(async () => ++n === 1 ? new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } }) : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    expect(await syncPhotosStep({ id: 'c', tenant_id: 't', api_key: 'K' }, { fetchImpl, upload })).toEqual({ saved: 1, none: 1, stopped: 'limit' })
    expect(upload).toHaveBeenCalledWith('t/c/-1.jpg', expect.anything(), 'image/jpeg')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
