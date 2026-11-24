import { describe, expect, it } from 'vitest'
import { recognitionPriceHint } from './aiPriceHint'

// 24.11.2026 (план C2): ціна розпізнавання до запуску — за досвідом цього магазину.
describe('recognition price before start', () => {
  it('shows the usual price for one or two photos and the heavy one for more', () => {
    const usage = { typical_usd: 0.0551, heavy_usd: 0.3761, sample: 50 }
    expect(recognitionPriceHint(usage, 1)).toBe('Фото: 1. Орієнтовна ціна розпізнавання ≈ $0.055 (у вашому магазині зазвичай $0.055, дорогий запит до $0.38; за 50 запитами за 30 днів).')
    expect(recognitionPriceHint(usage, 4)).toContain('≈ $0.38')
    expect(recognitionPriceHint(usage, 0)).toMatch(/^Орієнтовна ціна/)
  })

  it('says nothing without enough real data', () => {
    expect(recognitionPriceHint({}, 1)).toBeNull()
    expect(recognitionPriceHint({ typical_usd: 0.05, heavy_usd: 0.3, sample: 2 }, 1)).toBeNull()
    expect(recognitionPriceHint({ typical_usd: 0, heavy_usd: 0.3, sample: 10 }, 1)).toBeNull()
  })
})
