import { describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
import { TOKEN_PATTERN, clientPrice, createPriceLinkSchema, newPriceLinkToken, readPublicPriceList } from '../priceListLinkService.js'

describe('client price list link', () => {
  it('makes unguessable tokens of the stored shape', () => {
    const a = newPriceLinkToken(), b = newPriceLinkToken()
    expect(TOKEN_PATTERN.test(a)).toBe(true); expect(a).not.toBe(b)
  })
  it('never prices below purchase, rounds the discounted price up to a hryvnia', () => {
    expect(clientPrice(52500, 40136, 0)).toBe(52500)
    expect(clientPrice(52500, 40136, 10)).toBe(47300)
    expect(clientPrice(52500, 40136, 50)).toBe(40136)
    expect(clientPrice(10000, 0, 15)).toBe(8500)
  })
  it('limits the request to a sane size and discount', () => {
    const id = '00000000-0000-4000-8000-000000000001'
    expect(createPriceLinkSchema.safeParse({ title: 'Для СТО', product_ids: [id] }).success).toBe(true)
    expect(createPriceLinkSchema.safeParse({ title: 'x', product_ids: [id], discount_pct: 60 }).success).toBe(false)
    expect(createPriceLinkSchema.safeParse({ title: 'x', product_ids: [] }).success).toBe(false)
    expect(createPriceLinkSchema.safeParse({ title: 'x', product_ids: [id], tenant_id: 'other' }).success).toBe(false)
  })
  it('answers "not found" for a malformed token without touching the database', async () => {
    await expect(readPublicPriceList('../../etc')).rejects.toMatchObject({ status: 404 })
    expect(query).not.toHaveBeenCalled()
  })
  it('shows only public fields: no purchase price, no exact stock', async () => {
    query.mockResolvedValueOnce({ rows: [{ tenant_id: 't', title: 'Прайс', product_ids: ['p'], discount_pct: '10', show_stock: true,
      created_at: '2026-11-16T10:00:00Z', expires_at: '2026-11-30T10:00:00Z', shop_name: 'Форсаж', phone: '+380', shop_address: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'p', name: 'Щітка', sku: 'WB-1065', brand: 'Alloid', retail_price: 10000, purchase_price: 9500, qty: 3, photo_url: 'file:///C:/x.jpg' }] })
    const list = await readPublicPriceList('A'.repeat(32))
    expect(list.items[0]).toEqual({ id: 'p', name: 'Щітка', sku: 'WB-1065', brand: 'Alloid', photo_url: null, price: 9500, in_stock: true })
    expect(JSON.stringify(list)).not.toMatch(/purchase|qty_on_hand|"qty"/)
  })
})
