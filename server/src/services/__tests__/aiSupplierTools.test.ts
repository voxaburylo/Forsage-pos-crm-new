import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
import { applySupplierOfferUpdates, listSupplierOffersForAi, pickConnections } from '../aiSupplierTools.js'

// 26.11.2026, слово власника: «і ШІ має доступ до цієї бази теж — щоб там теж можна було перекладати товар,
// сортувати і так далі» (товари постачальників Омега, GPL).
const KEY = '0b6f4c1e-1111-4222-8333-944455556666:EXT1'
const omega = { id: '0b6f4c1e-1111-4222-8333-944455556666', name: 'Омега', provider: 'omega' }
const gpl = { id: '1b6f4c1e-1111-4222-8333-944455556666', name: 'GPL', provider: 'gpl' }

describe('assistant reads and changes supplier goods', () => {
  beforeEach(() => query.mockReset())

  it('finds the supplier by the word from the chat', () => {
    expect(pickConnections([omega, gpl], 'омега')).toEqual([omega])
    expect(pickConnections([omega, gpl], 'Omega')).toEqual([omega])
    expect(pickConnections([omega, gpl], 'gpl')).toEqual([gpl])
    expect(pickConnections([omega, gpl], '')).toEqual([omega, gpl])
  })

  it('pages of up to 200; hidden goods are not offered; a big list suggests a background job', async () => {
    query.mockResolvedValueOnce({ rows: [omega] }).mockResolvedValueOnce({ rows: [{ n: 7503 }] })
      .mockResolvedValueOnce({ rows: [{ key: KEY, number: 'OC 90', brand: 'KNECHT', name: 'Фильтр масляный KNECHT OC 90', supplier_category: 'Фильтры', category: null, total_qty: 3, hidden: false, supplier: 'Омега' }] })
    const out = await listSupplierOffersForAi('t', { supplier: 'Омега', filter: 'russian_names', per_page: 999 }) as any
    expect(out.total).toBe(7503)
    expect(out.pages).toBe(38)
    expect(out.hint).toContain('prepare_bulk_job')
    expect(out.offers[0]).toMatchObject({ key: KEY, number: 'OC 90', supplier: 'Омега' })
    const sql = String(query.mock.calls[2][0])
    expect(sql).toContain('NOT o.hidden')
    expect(sql).toContain('LIMIT 200 OFFSET 0')
  })

  it('applying: names pass the same check as background jobs; only existing categories; hide works; the price is never touched', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ key: KEY, number: 'OC 90', name: 'Фильтр масляный KNECHT OC 90' }, { key: KEY + 'b', number: 'OC 91', name: 'Фильтр KNECHT OC 91' }, { key: KEY + 'c', number: 'OC 92', name: 'Фильтр KNECHT OC 92' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'cat-1', name: 'Фільтри масляні' }] })
      .mockResolvedValue({ rowCount: 1 })
    const out = await applySupplierOfferUpdates('t', [
      { key: KEY, new_name: 'Фільтр масляний KNECHT OC 90', category_name: 'фільтри масляні' },
      { key: KEY + 'b', new_name: 'Фільтр масляний KNECHT OC 91 1.6 л' },
      { key: KEY + 'c', category_name: 'Нема такої' },
      { key: KEY + 'zzz', hidden: true },
    ])
    expect(out.updated).toBe(1)
    expect(out.errors.map(error => error.error)).toEqual([
      expect.stringContaining('Назва не пройшла перевірку'), expect.stringContaining('Категорії «Нема такої» немає'), expect.stringContaining('не знайдено'),
    ])
    const update = query.mock.calls.find(call => String(call[0]).startsWith('UPDATE supplier_offers'))
    expect(String(update?.[0])).toContain("custom_name = $3, category_id = $4, category_source = 'manual'")
    expect(String(update?.[0])).not.toMatch(/price|qty/)
  })

  it('wiring: both tools are known to the chat (read and bulk proposal); apply is owner/admin only and server-side', () => {
    const chat = readFileSync(new URL('../aiService.ts', import.meta.url), 'utf8')
    expect(chat).toContain("'find_duplicate_products', 'list_supplier_offers'])")
    expect(chat).toContain("'add_cross_numbers_bulk', 'update_supplier_offers_bulk'])")
    const route = readFileSync(new URL('../../routes/ai.ts', import.meta.url), 'utf8')
    expect(route).toContain("router.post('/supplier-offers/apply', requireRole('owner', 'admin')")
    const guard = readFileSync(new URL('../../middleware/localFirstWriteGuard.ts', import.meta.url), 'utf8')
    expect(guard).toContain("'/api/v1/ai/supplier-offers'")
  })
})
