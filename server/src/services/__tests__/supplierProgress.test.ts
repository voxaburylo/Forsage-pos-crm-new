import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db/pg.js', () => ({ pool: { query: vi.fn() } }))
import { FULL_PASS_EVERY_MS, OMEGA_PAGE_SIZE, PAGE_SIZE_BY_PROVIDER, connectionProgress, overallProgress, photoProgress, pricePassProgress, queueProgress } from '../supplierApiService.js'
import { GPL_PAGE_SIZE } from '../supplierGpl.js'

// 25.11.2026, слово власника: «не видно, чи йде синхронізація зі складом — кружечок, що заповнюється зеленим,
// і скільки лишилось у днях, годинах, хвилинах; ненавʼязливо».
describe('supplier load progress for the settings circle', () => {
  const HOUR = 3_600_000

  it('page sizes match the real loaders', () => {
    expect(PAGE_SIZE_BY_PROVIDER.omega).toBe(OMEGA_PAGE_SIZE)
    expect(PAGE_SIZE_BY_PROVIDER.gpl).toBe(GPL_PAGE_SIZE)
  })

  it('price pass: share of pages done, time left from the real speed since the pass started', () => {
    const now = Date.parse('2026-11-25T22:00:00Z')
    // 80 сторінок по 1000; зроблено 20 за 1 годину → лишилось 60 сторінок ≈ 3 години.
    const progress = pricePassProgress({ provider: 'omega', sync_page: 21, sync_started_at: new Date(now - HOUR).toISOString(), last_full_sync_at: null, total_offers: 80_000 }, now)
    expect(progress.loading).toBe(true)
    expect(progress.fraction).toBeCloseTo(0.25)
    expect(progress.eta_ms).toBe(3 * HOUR)
    // Перша сторінка ще йде — швидкості немає, час не вигадуємо.
    expect(pricePassProgress({ provider: 'gpl', sync_page: 1, sync_started_at: new Date(now).toISOString(), last_full_sync_at: null, total_offers: 4000 }, now))
      .toEqual({ fraction: 0, eta_ms: null, loading: true, next_at: null })
    // Розмір прайсу ще невідомий — без відсотків.
    expect(pricePassProgress({ provider: 'gpl', sync_page: 3, sync_started_at: new Date(now - HOUR).toISOString(), last_full_sync_at: null, total_offers: null }, now).fraction).toBeNull()
  })

  it('finished pass is a full circle with the next pass time; never loaded is an empty one', () => {
    const last = '2026-11-25T20:00:00.000Z'
    expect(pricePassProgress({ provider: 'omega', sync_page: 1, sync_started_at: null, last_full_sync_at: last, total_offers: 79_000 }))
      .toEqual({ fraction: 1, eta_ms: null, loading: false, next_at: new Date(Date.parse(last) + FULL_PASS_EVERY_MS).toISOString() })
    expect(pricePassProgress({ provider: 'omega', sync_page: 1, sync_started_at: null, last_full_sync_at: null, total_offers: null }))
      .toEqual({ fraction: 0, eta_ms: null, loading: false, next_at: null })
  })

  it('crosses and descriptions: time left from how many were done in the last hour', () => {
    expect(queueProgress(1_000, 79_000, 200)).toEqual({ fraction: 1_000 / 79_000, eta_ms: 390 * HOUR, loading: true, next_at: null })
    expect(queueProgress(500, 1_000, 0).eta_ms).toBeNull()
    expect(queueProgress(1_000, 1_000, 0)).toEqual({ fraction: 1, eta_ms: 0, loading: false, next_at: null })
    expect(queueProgress(0, 0, 0).fraction).toBeNull()
  })
})

// 26.11.2026, фото власника: «чому склади окремо, Омега окремо, і лічильник пише “завантажено”, хоча кроси ще
// вантажаться; фото теж — має бути один повзунок загального стану всіх завантажень, а докладно — у меню».
describe('one overall circle for all loads of a supplier', () => {
  const HOUR = 3_600_000
  const done = { fraction: 1, eta_ms: null, loading: false, next_at: '2026-11-26T06:00:00.000Z' }

  it('price loaded but crosses still loading → overall is still loading, with the longest known time left', () => {
    const overall = overallProgress([done, { fraction: 0.02, eta_ms: 16 * 24 * HOUR, loading: true, next_at: null }, { fraction: 0.5, eta_ms: HOUR, loading: true, next_at: null }])
    expect(overall.loading).toBe(true)
    expect(overall.fraction).toBeCloseTo((1 + 0.02 + 0.5) / 3)
    expect(overall.eta_ms).toBe(16 * 24 * HOUR)
    expect(overallProgress([done, done]).loading).toBe(false)
    expect(overallProgress([done, done]).next_at).toBe('2026-11-26T06:00:00.000Z')
  })

  // 26.11.2026 (власник: «робіть усі рекомендації»): фото більше не чекають кроси — ліміт ділиться.
  it('photos load together with crosses (shared limit) and say so; switched-off photos say so too', () => {
    const crossesLoading = { fraction: 0.1, eta_ms: HOUR, loading: true, next_at: null }
    expect(photoProgress({ photos_enabled: true, photos_total: 78_000, photos_done: 4_000, photos_hour: 96 }, crossesLoading))
      .toMatchObject({ loading: true, eta_ms: 74_000 * HOUR / 96, note: 'разом із кросами, повільніше' })
    expect(photoProgress({ photos_enabled: false, photos_total: 10, photos_done: 1 }, crossesLoading)).toMatchObject({ loading: false, note: 'вимкнено' })
  })

  it('Omega gets price, crosses, description and photos; GPL only price (photos and description come in its price list)', () => {
    const omega = connectionProgress({ provider: 'omega', sync_page: 1, sync_started_at: null, last_full_sync_at: '2026-11-26T03:00:00Z', total_offers: 79_000,
      offers: 79_000, crosses_done: 1_000, crosses_hour: 200, details_done: 900, details_hour: 240, photos_enabled: true, photos_total: 78_000, photos_done: 4_000, photos_hour: 0 })
    expect(Object.keys(omega).sort()).toEqual(['crosses', 'details', 'overall', 'photos', 'price'])
    expect(omega.price.loading).toBe(false)
    expect(omega.overall.loading).toBe(true)
    const gpl = connectionProgress({ provider: 'gpl', sync_page: 300, sync_started_at: new Date(Date.now() - HOUR).toISOString(), last_full_sync_at: null, total_offers: 838_544 })
    expect(Object.keys(gpl).sort()).toEqual(['overall', 'price'])
  })
})
