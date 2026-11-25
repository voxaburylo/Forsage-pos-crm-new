import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db/pg.js', () => ({ pool: { query: vi.fn() } }))
import { gplCredentials, gplImage, gplLogin, gplOffer, gplPage, gplPurchase } from '../supplierGpl.js'
import { connectionSchema } from '../supplierApiService.js'

const item = (over: Record<string, unknown> = {}) => ({ cid: '1000123', category: 'Автохімія', brand: 'K2', article: 'K20118', partNumber: 'K20118', name: 'Очисник скла K2 KLAREN 750 мл',
  description: 'Для скла й дзеркал', imagePath: '/storage/products/k20118.jpg',
  prices: [{ id: 1, name: 'Роздрібна', price: '189.00' }, { id: 2, name: 'Ваша ціна', price: '121.50' }],
  warehouses: [{ id: 1, name: 'Київ', quantity: '12' }, { id: 2, name: 'Львів', quantity: '0' }, { id: 3, name: 'Одеса', quantity: '>50' }], ...over })

// 25.11.2026 (власник: «ознайомся з постачальником GPL… усе те саме — під замовлення, склади менеджеру й на сайт»).
describe('GPL supplier', () => {
  it('turns a price row into an offer: article, brand, description, category, photo, stock per warehouse, purchase not retail', () => {
    expect(gplOffer(item())).toEqual({ external_id: '1000123', number: 'K20118', number_code: 'K20118', brand: 'K2', name: 'Очисник скла K2 KLAREN 750 мл',
      barcode: null, image_url: 'https://back.online.gpl.ua/storage/products/k20118.jpg', purchase_price: 12150, retail_price: 0,
      stock: [{ w: 'Київ', q: 12 }, { w: 'Одеса', q: 50 }], total_qty: 62, description: 'Для скла й дзеркал', category_name: 'Автохімія' })
    expect(gplOffer(item({ article: '', partNumber: '' }))).toBeNull()
    expect(gplOffer(item({ prices: [] }))).toBeNull()
  })

  it('takes the lowest non-retail price as the purchase price, and says which one', () => {
    expect(gplPurchase([{ name: 'РРЦ', price: '200' }, { name: 'Опт', price: '150,40' }, { name: 'Дилер', price: '140' }])).toEqual({ kopecks: 14000, name: 'Дилер' })
    expect(gplPurchase([{ name: 'Роздрібна', price: '99' }])).toEqual({ kopecks: 9900, name: 'Роздрібна' })
    expect(gplImage('javascript:alert(1)')).toBeNull()
    expect(gplImage('https://cdn.gpl.ua/a.jpg')).toBe('https://cdn.gpl.ua/a.jpg')
  })

  it('logs in with login and password, then reads pages with the bearer token', async () => {
    const calls: Array<[string, RequestInit]> = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init])
      if (url.endsWith('/api/v2/auth/login')) return new Response(JSON.stringify({ success: true, data: { token: 'T0K3N' } }), { status: 200 })
      return new Response(JSON.stringify({ success: true, data: [item()], meta: { total: 401, lastPage: 3 } }), { status: 200 })
    }) as unknown as typeof fetch
    expect(await gplLogin({ login: 'shop', password: 'secret' }, { fetchImpl })).toBe('T0K3N')
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ login: 'shop', password: 'secret' })
    const page = await gplPage('T0K3N', 2, { fetchImpl })
    expect(page).toMatchObject({ total: 401, lastPage: 3 })
    expect(calls[1][0]).toContain('/api/v2/prices?page=2&perPage=200')
    expect((calls[1][1].headers as Record<string, string>).Authorization).toBe('Bearer T0K3N')
  })

  it('a refused login is a clear message; stored credentials must be complete', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401 })) as unknown as typeof fetch
    await expect(gplLogin({ login: 'x', password: 'y' }, { fetchImpl })).rejects.toThrow(/логін або пароль/)
    expect(() => gplCredentials('{"login":"a"}')).toThrow(/Логін і пароль GPL/)
    expect(gplCredentials('{"login":"a","password":"b"}')).toEqual({ login: 'a', password: 'b' })
  })

  it('the settings accept GPL with login and password, Omega with its key', () => {
    expect(connectionSchema.safeParse({ provider: 'gpl', login: 'shop', password: 'secret1' }).success).toBe(true)
    expect(connectionSchema.safeParse({ provider: 'gpl', api_key: 'ABCDEFGH' }).success).toBe(false)
    expect(connectionSchema.safeParse({ provider: 'omega', api_key: 'ABCDEFGH12' }).success).toBe(true)
  })

  it('settings show GPL with login and password fields; the order form shows its category and description', () => {
    const card = readFileSync(new URL('../../../../apps/web/src/features/settings/SupplierApiCard.tsx', import.meta.url), 'utf8')
    expect(card).toContain("provider: 'gpl'")
    expect(card).toContain('type="password"')
    expect(card).toContain('data-supplier-gpl')
    const offers = readFileSync(new URL('../../../../apps/web/src/features/orders/SupplierOfferSuggestions.tsx', import.meta.url), 'utf8')
    expect(offers).toContain('offer.category_name')
    const service = readFileSync(new URL('../supplierApiService.ts', import.meta.url), 'utf8')
    expect(service).toContain("if (row.provider !== 'omega') continue")
  })
})
