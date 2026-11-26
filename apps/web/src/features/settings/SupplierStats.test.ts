import { describe, expect, it } from 'vitest'
import { loadingNote, supplierTiles, type SupplierStatsSource } from './SupplierStats'

// 26.11.2026, слово власника: «лише фото, товари, кроси, опис — що є і що це дає сайту».
const base: SupplierStatsSource = { provider: 'omega', offers: 79247, total_offers: 79816, linked: 372, crosses_done: 2513, details_done: 3020,
  photos_have: 4803, descriptions: 0, syncing: false, sync_page: 0, last_full_sync_at: '2026-11-26T08:37:41Z',
  progress: { price: { fraction: 1, eta_ms: null, loading: false, next_at: null }, crosses: { fraction: 0.03, eta_ms: 26 * 86400000 + 15 * 3600000, loading: true, next_at: null },
    details: { fraction: 0.03, eta_ms: null, loading: true, next_at: null }, photos: { fraction: 0.06, eta_ms: null, loading: false, next_at: null, note: 'вимкнено' } } }

describe('supplier tiles: goods, photos, crosses, description', () => {
  it('Omega: four numbers with a short line of what is still loading', () => {
    // Число пишеться з нерозривним пробілом (uk-UA) — у перевірці звичайний.
    const tiles = supplierTiles(base).map(tile => ({ ...tile, note: tile.note.replace(/\s/g, ' ') }))
    expect(tiles.map(tile => [tile.key, tile.value])).toEqual([['goods', 79247], ['photos', 4803], ['crosses', 2513], ['details', 3020]])
    expect(tiles[0].note).toBe('з 79 816 у прайсі · у вас є 372')
    expect(tiles[2].note).toBe('вантажиться · 3 % · ≈ 26 дн 15 год')
    expect(tiles[1].note).toBe('вимкнено')
  })

  it('GPL: photos come with the price; crosses come from Omega by article; description counts real texts', () => {
    const tiles = supplierTiles({ ...base, provider: 'gpl', offers: 29799, total_offers: 838544, photos_have: 28779, descriptions: 3915, syncing: true, sync_page: 298, progress: undefined })
    expect(tiles.map(tile => [tile.key, tile.value])).toEqual([['goods', 29799], ['photos', 28779], ['crosses', null], ['details', 3915]])
    expect(tiles[0].note).toContain('вантажиться (сторінка 298)')
    expect(tiles[2].note).toContain('з Омеги')
  })

  it('loading line: done, idle and switched-off states read plainly (letter «s» check: «вимкнено»)', () => {
    expect(loadingNote({ fraction: 1, eta_ms: null, loading: false, next_at: null })).toBe('усе завантажено')
    expect(loadingNote({ fraction: 0.2, eta_ms: null, loading: false, next_at: null, note: 'вимкнено' })).toBe('вимкнено')
    expect(loadingNote(undefined)).toBe('')
  })
})
