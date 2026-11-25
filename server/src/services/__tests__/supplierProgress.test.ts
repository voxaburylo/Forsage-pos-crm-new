import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db/pg.js', () => ({ pool: { query: vi.fn() } }))
import { FULL_PASS_EVERY_MS, OMEGA_PAGE_SIZE, PAGE_SIZE_BY_PROVIDER, pricePassProgress, queueProgress } from '../supplierApiService.js'
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
