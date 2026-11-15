import { describe, expect, it } from 'vitest'
import { retainTidyOperation, tidyInfoLines, tidyResultText, tidyStepText, type TidyStep } from './catalogTidyModel'

describe('catalog tidy panel model', () => {
  it('describes every step the desktop offers', () => {
    const steps: TidyStep[] = ['duplicates', 'sku', 'prices', 'names', 'garbage', 'categories']
    for (const step of steps) {
      expect(tidyStepText[step].title.length).toBeGreaterThan(5)
      expect(tidyStepText[step].what.length).toBeGreaterThan(20)
    }
    expect(Object.keys(tidyStepText).sort()).toEqual([...steps].sort())
    // Власник має бачити правило ціни до підтвердження, а не після.
    expect(tidyStepText.duplicates.what).toContain('більша з карток')
    expect(tidyStepText.prices.what).toContain('вгору до 5 грн')
    expect(tidyStepText.prices.what).toContain('Закупівельні ціни не змінюються')
    expect(tidyStepText.garbage.what).toContain('немає залишку й жодного документа')
  })

  it('lists only what is left for the owner to check by hand', () => {
    expect(tidyInfoLines({ lost_thousands: 0, zero_or_below_cost: 0, uncategorized_left: 0, manual_duplicate_groups: 0, garbage_kept: 0 })).toEqual([])
    const lines = tidyInfoLines({ lost_thousands: 169, zero_or_below_cost: 246, uncategorized_left: 1322, manual_duplicate_groups: 50, garbage_kept: 2 })
    expect(lines).toHaveLength(5)
    expect(lines[0]).toContain('169')
    expect(lines.join(' ')).toContain('Не змінюються')
  })

  it('reports the outcome with skipped records, never hiding them', () => {
    expect(tidyResultText({ step: 'prices', changed: 339, skipped: [] })).toBe('Округлити ціни без копійок: 339 цін округлено.')
    expect(tidyResultText({ step: 'duplicates', changed: 26, skipped: [{ name: 'Патрубок', reason: 'у ревізії' }] }))
      .toBe('Об’єднати точні дублі: 26 груп об’єднано, пропущено 1.')
  })

  it('reuses the operation number only for a repeat of the same step and list', () => {
    const first = retainTidyOperation(null, 'prices', 'a'.repeat(64), () => 'op-1')
    expect(first).toEqual({ step: 'prices', fingerprint: 'a'.repeat(64), operation_id: 'op-1' })
    expect(retainTidyOperation(first, 'prices', 'a'.repeat(64), () => 'op-2')).toBe(first)
    expect(retainTidyOperation(first, 'names', 'a'.repeat(64), () => 'op-3').operation_id).toBe('op-3')
    expect(retainTidyOperation(first, 'prices', 'b'.repeat(64), () => 'op-4').operation_id).toBe('op-4')
  })
})
