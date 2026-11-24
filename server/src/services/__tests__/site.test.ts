import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
const clientQuery = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query, connect: async () => ({ query: clientQuery, release: () => undefined }) } }))
vi.mock('../tillWake.js', () => ({ wakeTill: vi.fn(async () => undefined) }))
import {
  DEFAULT_SITE_SETTINGS, SITE_KEY_PATTERN, createSiteOrder, newSiteKey, readSiteSettings, siteAccess, siteAdminUpdateSchema,
  siteKeyHash, sitePhone, sitePrice, siteProducts, type SiteAccess,
} from '../siteService.js'
import { PENDING_COMMAND_TTL_SQL, SITE_ORDER_AUTHOR, orderSavePayload } from '../tillCommandService.js'
import { isWriteAllowed } from '../../middleware/localFirstWriteGuard.js'

const P1 = '00000000-0000-4000-8000-000000000001', P2 = '00000000-0000-4000-8000-000000000002'
const access = (over: Partial<SiteAccess['settings']> = {}): SiteAccess => ({ tenant_id: 't', owner_id: '00000000-0000-4000-8000-0000000000aa',
  updated_at: '2026-11-24T10:00:00.000Z', settings: { ...DEFAULT_SITE_SETTINGS, ...over } })
const card = (over: Record<string, unknown> = {}) => ({ id: P1, sku: 'WB-1065', name: 'Щітка', barcode: null, unit: 'шт', category_id: null, oem_number: null,
  photo_url: 'file:///C:/x.jpg', retail_price: 10000, purchase_price: 9500, qty: 3, updated_at: '2026-11-24T09:00:00Z', brand: 'Alloid', visible: true, cursor_at: '2026-11-24T09:00:00.000000Z', ...over })

// 24.11.2026 (власник: «сайт — окремий розділ, керую всім сам»).
describe('shop site', () => {
  beforeEach(() => { query.mockReset(); clientQuery.mockReset() })

  it('site price follows the owner percent, rounds up to a hryvnia and never goes below purchase', () => {
    expect(sitePrice(52500, 40136, 0)).toBe(52500)
    expect(sitePrice(52500, 40136, -10)).toBe(47300)
    expect(sitePrice(52500, 40136, -50)).toBe(40136)
    expect(sitePrice(10000, 0, 5)).toBe(10500)
    expect(sitePrice(0, 500, 0)).toBe(0)
  })

  it('the key is long, random and stored only as a fingerprint', () => {
    const a = newSiteKey(), b = newSiteKey()
    expect(SITE_KEY_PATTERN.test(a)).toBe(true); expect(a).not.toBe(b)
    expect(siteKeyHash(a)).toMatch(/^[a-f0-9]{64}$/); expect(siteKeyHash(a)).not.toContain(a.slice(4, 12))
  })

  it('a malformed key is refused without touching the database; a switched-off site answers "disabled"', async () => {
    await expect(siteAccess('nope')).rejects.toMatchObject({ status: 401 })
    await expect(siteAccess(undefined)).rejects.toMatchObject({ status: 401 })
    expect(query).not.toHaveBeenCalled()
    query.mockResolvedValueOnce({ rows: [] })
    await expect(siteAccess(newSiteKey())).rejects.toMatchObject({ status: 401, code: 'SITE_KEY_INVALID' })
    query.mockResolvedValueOnce({ rows: [{ tenant_id: 't', enabled: false, settings: {}, updated_at: '2026-11-24T10:00:00Z', updated_by: null }] })
    await expect(siteAccess(newSiteKey())).rejects.toMatchObject({ status: 403, code: 'SITE_DISABLED' })
  })

  it('old or broken saved settings fall back to defaults field by field', () => {
    expect(readSiteSettings(null)).toEqual(DEFAULT_SITE_SETTINGS)
    expect(readSiteSettings({ stock_mode: 'qty', price_change_pct: 900, extra: 1 })).toEqual({ ...DEFAULT_SITE_SETTINGS, stock_mode: 'qty' })
    expect(siteAdminUpdateSchema.safeParse({ enabled: true, settings: DEFAULT_SITE_SETTINGS }).success).toBe(true)
    expect(siteAdminUpdateSchema.safeParse({ enabled: true, settings: { ...DEFAULT_SITE_SETTINGS, price_change_pct: -60 } }).success).toBe(false)
    expect(siteAdminUpdateSchema.safeParse({ enabled: true, settings: DEFAULT_SITE_SETTINGS, tenant_id: 'x' }).success).toBe(false)
  })

  it('the catalog never shows purchase price; stock and price follow the owner switches; removed cards are marked', async () => {
    query.mockResolvedValueOnce({ rows: [card(), card({ id: P2, visible: false })] })
    const flag = await siteProducts(access(), { updated_since: '2026-11-24T00:00:00Z' })
    expect(flag.items[0]).toEqual({ id: P1, sku: 'WB-1065', name: 'Щітка', brand: 'Alloid', category_id: null, barcode: null, oem_number: null, unit: 'шт',
      photo_url: null, price: 10000, in_stock: true, updated_at: '2026-11-24T09:00:00.000Z' })
    expect(flag.items[1]).toEqual({ id: P2, removed: true, updated_at: '2026-11-24T09:00:00.000Z' })
    expect(flag.next_cursor).toBeNull()
    expect(JSON.stringify(flag)).not.toMatch(/purchase|9500|"qty"/)

    query.mockResolvedValueOnce({ rows: [card()] })
    const hidden = await siteProducts(access({ show_prices: false, stock_mode: 'hidden' }), {})
    expect(hidden.items[0]).not.toHaveProperty('price'); expect(hidden.items[0]).not.toHaveProperty('in_stock')
    query.mockResolvedValueOnce({ rows: [card({ qty: -2 })] })
    expect((await siteProducts(access({ stock_mode: 'qty' }), {})).items[0]).toMatchObject({ in_stock: false, qty: 0 })
  })

  it('pages by a cursor and refuses a broken one', async () => {
    query.mockResolvedValueOnce({ rows: [card(), card({ id: P2 })] })
    const page = await siteProducts(access(), { limit: '1' })
    expect(page.items).toHaveLength(1); expect(page.next_cursor).toBeTruthy()
    query.mockResolvedValueOnce({ rows: [] })
    await siteProducts(access(), { cursor: page.next_cursor })
    expect(query.mock.calls[1][1].slice(4, 6)).toEqual(['2026-11-24T09:00:00.000000Z', P1])
    await expect(siteProducts(access(), { cursor: 'AAAA' })).rejects.toMatchObject({ status: 422 })
    await expect(siteProducts(access(), { limit: '5000' })).rejects.toMatchObject({ status: 422 })
  })

  it('an order is priced by the server and goes to the till as an ordinary order form, with no money in it', async () => {
    query.mockResolvedValueOnce({ rows: [] })                                   // повтору немає
      .mockResolvedValueOnce({ rows: [card(), card({ id: P2, name: 'Фільтр', sku: null, retail_price: 20000, purchase_price: 0 })] })
      .mockResolvedValueOnce({ rows: [{ id: 'o1', external_id: 'S-7', customer_name: 'Іван', customer_phone: '380501234567', delivery: null, comment: null,
        items: [], total_amount: 39000, created_at: '2026-11-24T10:00:00Z', status: 'pending', error: null, result: null }] })
    clientQuery.mockImplementation(async (sql: string) => /INSERT INTO site_orders/.test(sql) ? { rows: [{ id: '00000000-0000-4000-8000-0000000000bb' }] } : { rows: [] })
    const order = await createSiteOrder(access({ price_change_pct: -5 }), { external_id: 'S-7', customer_name: 'Іван', customer_phone: '+38 (050) 123-45-67',
      delivery: 'Нова пошта, Київ 12', items: [{ product_id: P1, qty: 1 }, { product_id: P2, qty: 1 }, { product_id: P1, qty: 1 }] })
    expect(order).toMatchObject({ external_id: 'S-7', state: 'waiting', total_amount: 39000 })
    const command = clientQuery.mock.calls.find(call => /INSERT INTO till_commands/.test(String(call[0])))!
    const payload = JSON.parse(command[1][2])
    expect(orderSavePayload.safeParse(payload).success).toBe(true)
    expect(payload).toMatchObject({ author: SITE_ORDER_AUTHOR, customer_phone: '380501234567' })
    // Щітка: 100 грн −5% = 95 грн, це якраз закупка; дві штуки одним рядком. Фільтр: 200 −5% = 190 грн.
    expect(payload.items).toEqual([{ name: 'Щітка', sku: 'WB-1065', qty: 2, sell_price: 9500, product_id: P1 }, { name: 'Фільтр', sku: null, qty: 1, sell_price: 19000, product_id: P2 }])
    expect(JSON.stringify(payload)).not.toMatch(/payment|prepay|paid/)
    expect(command[1][3]).toBe(access().owner_id)
  })

  it('refuses an order when orders are off, a product is gone, the sum is too small or the phone is wrong', async () => {
    const body = { external_id: 'S-8', customer_name: 'Іван', customer_phone: '0501234567', items: [{ product_id: P1, qty: 1 }] }
    await expect(createSiteOrder(access({ accept_orders: false }), body)).rejects.toMatchObject({ code: 'SITE_ORDERS_OFF' })
    await expect(createSiteOrder(access(), { ...body, customer_phone: '12345' })).rejects.toMatchObject({ status: 422 })
    await expect(createSiteOrder(access(), { ...body, items: [{ product_id: P1, qty: 1, price: 1 }] })).rejects.toMatchObject({ status: 422 })
    expect(() => sitePhone('abc')).toThrow()
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [card({ visible: false })] })
    await expect(createSiteOrder(access(), body)).rejects.toMatchObject({ code: 'SITE_PRODUCT_UNAVAILABLE' })
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [card()] })
    await expect(createSiteOrder(access({ min_order_kopecks: 50000 }), body)).rejects.toMatchObject({ code: 'SITE_ORDER_TOO_SMALL' })
    expect(clientQuery).not.toHaveBeenCalled()
  })

  it('a repeat with the same site number returns the same order and creates nothing', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'o1', external_id: 'S-9', customer_name: 'Іван', customer_phone: '380501234567', delivery: null, comment: null,
      items: [], total_amount: 100, created_at: '2026-11-24T10:00:00Z', status: 'done', error: null, result: { order_number: 412 } }] })
    const order = await createSiteOrder(access(), { external_id: 'S-9', customer_name: 'Іван', customer_phone: '0501234567', items: [{ product_id: P1, qty: 1 }] })
    expect(order).toMatchObject({ state: 'in_program', order_number: '412' })
    expect(clientQuery).not.toHaveBeenCalled()
  })

  it('a site order waits for the till for 7 days; the site may post orders and the owner may save settings from the web', () => {
    expect(PENDING_COMMAND_TTL_SQL).toContain("command = 'order.save' AND payload->>'author' = 'Сайт' THEN 604800")
    const request = (method: string, path: string) => ({ method, path, get: () => undefined }) as never
    expect(isWriteAllowed(request('POST', '/api/v1/site/orders'))).toBe(true)
    expect(isWriteAllowed(request('PUT', '/api/v1/site-admin'))).toBe(true)
    expect(isWriteAllowed(request('POST', '/api/v1/site-admin/key'))).toBe(true)
    expect(isWriteAllowed(request('POST', '/api/v1/sitex/orders'))).toBe(false)
  })
})
