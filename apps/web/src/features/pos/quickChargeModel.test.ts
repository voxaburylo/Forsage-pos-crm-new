import { describe, expect, it } from 'vitest'
import { FREE_SALE_MAX_LINES, freeSaleLineName, freeSaleName, freeSaleSku, nextFreeSaleIndex } from './quickChargeModel'

describe('free amount lines on the till', () => {
  it('a second free amount gets its own line instead of replacing the first (tyres 19 600 + gloves 100)', () => {
    expect(nextFreeSaleIndex([])).toBe(1)
    expect(nextFreeSaleIndex(['89332', 'POS-FREE-SALE'])).toBe(2)
    expect(nextFreeSaleIndex(['POS-FREE-SALE', 'POS-FREE-SALE-2'])).toBe(3)
    expect(nextFreeSaleIndex(['POS-FREE-SALE-2'])).toBe(1)
    expect(nextFreeSaleIndex(Array.from({ length: FREE_SALE_MAX_LINES }, (_, i) => freeSaleSku(i + 1)))).toBeNull()
    expect(nextFreeSaleIndex(['POS-TIRE-SERVICE'])).toBe(1)
  })
  it('keeps the original service product for the first line and numbers the rest', () => {
    expect([freeSaleSku(1), freeSaleSku(2)]).toEqual(['POS-FREE-SALE', 'POS-FREE-SALE-2'])
    expect([freeSaleName(1), freeSaleName(3)]).toEqual(['Вільний продаж', 'Вільний продаж 3'])
  })
  it('shows the description in the line name', () => {
    expect(freeSaleLineName('Вільний продаж', '  рукавички ')).toBe('Вільний продаж: рукавички')
    expect(freeSaleLineName('Вільний продаж 2', '')).toBe('Вільний продаж 2')
  })
})
