import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { leftText, progressText } from './LoadRing'

// 25.11.2026, слово власника (фото з iPhone): «верхній бар частково перекриває налаштування, коли гортаєш; склади —
// у списку, що розгортається, і всі такі налаштування теж; не видно, чи йде синхронізація зі складом — маленький
// кружечок навпроти складу, заповнюється зеленим, і скільки лишилось у днях, годинах, хвилинах; ненавʼязливо, з анімацією».
describe('load circle text', () => {
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR

  it('time left in days, hours or minutes', () => {
    expect(leftText(null)).toBe('')
    expect(leftText(20_000)).toBe('< 1 хв')
    expect(leftText(15 * MIN)).toBe('≈ 15 хв')
    expect(leftText(HOUR + 20 * MIN)).toBe('≈ 1 год 20 хв')
    expect(leftText(3 * HOUR)).toBe('≈ 3 год')
    expect(leftText(2 * DAY + 5 * HOUR + 10 * MIN)).toBe('≈ 2 дн 5 год')
    expect(leftText(16 * DAY)).toBe('≈ 16 дн')
  })

  it('short caption: percent and time left while loading; done; never loaded', () => {
    expect(progressText({ fraction: 0.257, eta_ms: 3 * HOUR, loading: true, next_at: null })).toBe('25 % · лишилось ≈ 3 год')
    expect(progressText({ fraction: 0, eta_ms: null, loading: true, next_at: null })).toBe('0 %')
    expect(progressText({ fraction: null, eta_ms: null, loading: true, next_at: null })).toBe('завантажується')
    expect(progressText({ fraction: 1, eta_ms: null, loading: false, next_at: '2026-11-26T01:00:00Z' })).toBe('завантажено')
    expect(progressText({ fraction: 0, eta_ms: null, loading: false, next_at: null })).toBe('ще не завантажувалось')
    expect(progressText(null)).toBe('')
  })
})

describe('API keys tab layout', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

  it('suppliers and their warehouses fold; every warehouse row has the circle; numbers being typed survive the auto-refresh', () => {
    const card = read('./SupplierApiCard.tsx')
    expect(card).toContain('<details open={open || undefined}')
    // 26.11.2026: склади — усередині блоку постачальника; у заголовку — загальний стан усіх завантажень.
    expect(card).not.toContain('title={`Склади: ${conn.name}`}')
    expect(card).toContain('{warehousesOf(omega)}')
    expect(card).toContain('{warehousesOf(gpl)}')
    expect(card).toContain('conn.progress?.overall ?? conn.progress?.price')
    expect(card).toContain("<LoadRing progress={w.is_active ? conn.progress?.price : null}")
    expect(card).toContain('}, 120_000)')
    expect(card).toContain('...current }))')
    expect(card).toContain('data-supplier-gpl')
  })

  it('the settings tab bar sits flush at the very top, solid, nothing shows through above it', () => {
    expect(read('./SettingsTabs.tsx')).toContain('className="app-sticky-bar')
    const css = read('../../index.css')
    expect(css).toMatch(/\.app-sticky-bar \{[^}]*position: sticky;[^}]*top: -1rem;[^}]*margin-top: -1rem;[^}]*padding-top: 1rem;/)
    expect(css).toContain('.app-sticky-bar { top: -1.5rem; margin-top: -1.5rem; padding-top: 1.5rem; }')
    // Layout: відступ робочої області p-4 / md:p-6 — саме його й перекриває панель.
    expect(read('../../components/Layout.tsx')).toContain('app-main min-h-0 min-w-0 flex-1 p-4 md:p-6')
  })
})

describe('server notes next to the circle', () => {
  it('photos paused while crosses load, or switched off — said in words', () => {
    expect(progressText({ fraction: 0.05, eta_ms: null, loading: true, next_at: null, note: 'на паузі, поки вантажаться кроси' })).toBe('5 % · на паузі, поки вантажаться кроси')
    expect(progressText({ fraction: 0.4, eta_ms: null, loading: false, next_at: null, note: 'вимкнено' })).toBe('40 % · вимкнено')
  })
})
