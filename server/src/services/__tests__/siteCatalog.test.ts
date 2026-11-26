import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
import { bulkSupplierOffers, catalogQuerySchema, listSiteCatalog, OFFER_SEARCH_EXPR, parseOfferKey, patchSupplierOffer, searchTerms } from '../siteCatalogService.js'

// 26.11.2026, слово власника: «у вкладці “Сайт” — усі товари, наші й від постачальників, у купі: перегляд, редагування,
// штрихкод, масова робота з цінами; міні-фото; основне в один рядок; видаляти теж можна».
const KEY = '0b6f4c1e-1111-4222-8333-944455556666:ABC-12'

describe('site catalog: our goods and supplier goods in one list', () => {
  beforeEach(() => query.mockReset())

  it('search words are matched each on its own; LIKE wildcards in the text are not special', () => {
    expect(searchTerms('  Фільтр  MANN 712%_ ')).toEqual(['фільтр', 'mann', '712'])
    expect(searchTerms('a b c d e f g h')).toHaveLength(6)
  })

  it('our goods first, then supplier goods; the page takes the right slice of each; cashier never sees purchase prices', async () => {
    query.mockImplementation(async (sql: string = '') => {
      if (sql.startsWith('SELECT count(*)::int AS n FROM products')) return { rows: [{ n: 30 }] }
      if (sql.startsWith('SELECT count(*)::int AS n FROM supplier_offers')) return { rows: [{ n: 100 }] }
      if (sql.includes("'ours' AS kind")) return { rows: Array.from({ length: 10 }, (_, i) => ({ kind: 'ours', id: 'p' + i, name: 'n', price: '100', purchase: '50', qty: '2' })) }
      return { rows: Array.from({ length: 40 }, (_, i) => ({ kind: 'supplier', id: KEY + i, name: 'o', price: 200, purchase: 120, qty: 5, hidden: false, linked: true, custom: false })) }
    })
    const out = await listSiteCatalog('t', 'cashier', catalogQuerySchema.parse({ page: 1, per_page: 50 }))
    expect(out.total).toBe(130)
    expect(out.ours_total).toBe(30)
    expect(out.pages).toBe(3)
    expect(out.rows[0]).not.toHaveProperty('purchase')
    const owner = await listSiteCatalog('t', 'owner', catalogQuerySchema.parse({ page: 1, per_page: 50 }))
    expect(owner.rows[0].purchase).toBe(50)
    // Друга сторінка: наших лишилось 0 (30 < 50), товари постачальника — з 20-го.
    query.mockClear()
    await listSiteCatalog('t', 'owner', catalogQuerySchema.parse({ page: 2, per_page: 50 }))
    const offers = query.mock.calls.find(call => String(call[0]).includes("'supplier' AS kind"))
    expect(String(offers?.[0])).toContain('LIMIT 50 OFFSET 20')
    expect(query.mock.calls.some(call => String(call[0]).includes("'ours' AS kind"))).toBe(false)
  })

  it('search on supplier goods uses exactly the indexed expression (otherwise the 79k rows are read whole)', () => {
    const migration = readFileSync(new URL('../../../../supabase/migrations/20261126100000_site_catalog_search.sql', import.meta.url), 'utf8')
    expect(migration.replace(/\s+/g, ' ')).toContain(OFFER_SEARCH_EXPR.replaceAll('o.', ''))
  })

  it('a supplier offer key is «connection:external id»; anything else is refused', () => {
    expect(parseOfferKey(KEY)).toEqual({ connectionId: '0b6f4c1e-1111-4222-8333-944455556666', externalId: 'ABC-12' })
    expect(() => parseOfferKey('../products/1')).toThrow()
  })

  it('a site price below the purchase price is refused — goods are never sold below purchase', async () => {
    query.mockResolvedValueOnce({ rows: [{ purchase_price: 12000 }] })
    await expect(patchSupplierOffer('t', KEY, { custom_price: 11000 })).rejects.toMatchObject({ code: 'PRICE_BELOW_PURCHASE' })
    query.mockResolvedValueOnce({ rows: [{ purchase_price: 12000 }] }).mockResolvedValueOnce({ rowCount: 1 })
    await patchSupplierOffer('t', KEY, { custom_price: 15000, hidden: true, custom_name: 'Фільтр масляний MANN W712/75' })
    expect(String(query.mock.calls.at(-1)?.[0])).toContain('custom_name = $4, custom_price = $5, hidden = $6')
  })

  it('bulk ±% rounds up to 5 UAH and skips rows that would drop below purchase (and says how many)', async () => {
    query.mockResolvedValueOnce({ rows: [{ n: 2 }] }).mockResolvedValueOnce({ rowCount: 8 })
    const out = await bulkSupplierOffers('t', { keys: [KEY], price_pct: -10 })
    expect(out).toEqual({ changed: 8, below_purchase: 2 })
    const update = String(query.mock.calls[1][0])
    expect(update).toContain('ceil(COALESCE(custom_price, retail_price) * $3 / 500.0) * 500')
    expect(update).toContain('>= purchase_price')
    expect(query.mock.calls[1][1][2]).toBeCloseTo(0.9)
  })

  // 26.11.2026, слово власника: «товари → категорії → товари в категорії, як на великих сайтах; або “усі товари”».
  it('a chosen category shows its goods together with nested categories — ours and supplier goods alike', async () => {
    const OILS = '11111111-1111-4111-8111-111111111111', MOTOR = '22222222-2222-4222-8222-222222222222', OTHER = '33333333-3333-4333-8333-333333333333'
    query.mockImplementation(async (sql: string = '') => {
      if (sql.startsWith('SELECT id::text AS id, parent_id::text')) return { rows: [{ id: OILS, parent_id: null, name: 'Оливи' }, { id: MOTOR, parent_id: OILS, name: 'Моторні' }, { id: OTHER, parent_id: null, name: 'Фільтри' }] }
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ n: 1 }] }
      return { rows: [] }
    })
    await listSiteCatalog('t', 'owner', catalogQuerySchema.parse({ category: OILS }))
    const counts = query.mock.calls.filter(call => String(call[0]).startsWith('SELECT count(*)'))
    expect(counts).toHaveLength(2)
    for (const call of counts) {
      expect(String(call[0])).toMatch(/category_id = ANY\(\$2::uuid\[\]\)/)
      expect(call[1][1]).toEqual([OILS, MOTOR])
    }
    query.mockClear()
    await listSiteCatalog('t', 'owner', catalogQuerySchema.parse({ category: 'none' }))
    expect(String(query.mock.calls[0][0])).toContain('category_id IS NULL OR NOT EXISTS')
    query.mockClear()
    await listSiteCatalog('t', 'owner', catalogQuerySchema.parse({}))
    // «Усі товари» — без відбору за категорією (у переліку рядків категорія лише підписується).
    expect(query.mock.calls.filter(call => String(call[0]).startsWith('SELECT count(*)')).some(call => String(call[0]).includes('category_id'))).toBe(false)
    expect(catalogQuerySchema.safeParse({ category: "x' OR 1=1" }).success).toBe(false)
  })

  // 26.11.2026, слово власника: «ще з фото, і за постачальниками; які в наявності».
  it('with photo, in stock and one supplier: the right conditions; one supplier hides our own goods', async () => {
    const CONN = '44444444-4444-4444-8444-444444444444'
    query.mockImplementation(async (sql: string = '') => sql.startsWith('SELECT count(*)') ? { rows: [{ n: 1 }] } : { rows: [] })
    await listSiteCatalog('t', 'owner', catalogQuerySchema.parse({ flag: 'with_photo' }))
    const photo = query.mock.calls.filter(call => String(call[0]).startsWith('SELECT count(*)')).map(call => String(call[0]))
    expect(photo[0]).toContain("COALESCE(p.photo_url, '') <> ''")
    expect(photo[1]).toContain("COALESCE(o.image_url, '') <> ''")
    query.mockClear()
    await listSiteCatalog('t', 'owner', catalogQuerySchema.parse({ flag: 'in_stock', connection: CONN }))
    const counts = query.mock.calls.filter(call => String(call[0]).startsWith('SELECT count(*)'))
    expect(counts).toHaveLength(1) // наших не рахуємо — вибрано одного постачальника
    expect(String(counts[0][0])).toContain('o.total_qty > 0')
    expect(String(counts[0][0])).toMatch(/o\.connection_id = \$2/)
    expect(counts[0][1]).toEqual(['t', CONN])
    expect(catalogQuerySchema.safeParse({ connection: 'omega' }).success).toBe(false)
  })
})
