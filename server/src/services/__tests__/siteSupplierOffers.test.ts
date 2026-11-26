import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
vi.mock('../tillWake.js', () => ({ wakeTill: vi.fn(async () => undefined) }))
import { DEFAULT_SITE_SETTINGS, siteSupplierOffers, type SiteAccess } from '../siteService.js'

const C = '00000000-0000-4000-8000-00000000000c'
const access = (over: Partial<SiteAccess['settings']> = {}): SiteAccess => ({ tenant_id: 't', owner_id: null, updated_at: '2026-11-26T10:00:00.000Z', settings: { ...DEFAULT_SITE_SETTINGS, ...over } })
const offer = (over: Record<string, unknown> = {}) => ({ key: C + ':-87748', number: '36489', brand: 'A.B.S.', name: 'Колодки гальмівні', barcode: null,
  image_url: 'https://our.storage/x.jpg', description: 'OE 34216', category_id: null, product_id: null, retail_price: 47800, purchase_price: 36702, total_qty: 11,
  updated_at: '2026-11-26T09:00:00Z', visible: true, days_to_ship: 1, cursor_at: '2026-11-26T09:00:00.000000Z', ...over })

// 26.11.2026, власник: «так, робіть усі рекомендації» — сайт отримує товари постачальників із фото.
describe('supplier goods for the site', () => {
  beforeEach(() => query.mockReset())

  it('gives name, photo, price by the site rule, stock and delivery days — never purchase or supplier name', async () => {
    query.mockResolvedValueOnce({ rows: [offer(), offer({ key: C + ':2', visible: false })] })
    const page = await siteSupplierOffers(access({ price_change_pct: -50 }), { updated_since: '2026-11-26T00:00:00Z' })
    expect(page.items[0]).toEqual({ id: 'S-' + C + ':-87748', number: '36489', brand: 'A.B.S.', name: 'Колодки гальмівні', barcode: null, category_id: null,
      same_as_product_id: null, photo_url: 'https://our.storage/x.jpg', description: 'OE 34216', days_to_ship: 1, price: 36702, in_stock: true, updated_at: '2026-11-26T09:00:00.000Z' })
    expect(page.items[1]).toEqual({ id: 'S-' + C + ':2', removed: true, updated_at: '2026-11-26T09:00:00.000Z' })
    expect(JSON.stringify(page)).not.toMatch(/purchase|supplier|Омега|GPL/)
    const sql = String(query.mock.calls[0][0])
    expect(sql).toContain('NOT o.hidden'); expect(sql).toContain('o.total_qty > 0'); expect(sql).toContain('c.enabled')
  })

  it('pages by a cursor; a broken cursor is refused; the route is behind the site key', async () => {
    query.mockResolvedValueOnce({ rows: [offer(), offer({ key: C + ':9' })] })
    const page = await siteSupplierOffers(access(), { limit: '1' })
    expect(page.next_cursor).toBeTruthy()
    query.mockResolvedValueOnce({ rows: [] })
    await siteSupplierOffers(access(), { cursor: page.next_cursor })
    expect(query.mock.calls[1][1].slice(3, 5)).toEqual(['2026-11-26T09:00:00.000000Z', C + ':-87748'])
    await expect(siteSupplierOffers(access(), { cursor: 'AAAA' })).rejects.toMatchObject({ status: 422 })
    const routes = readFileSync(new URL('../../routes/site.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(routes.indexOf("siteRouter.get('/supplier-offers'")).toBeGreaterThan(routes.indexOf('siteRouter.use(requireSite)'))
  })
})
