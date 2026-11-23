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

// 23.11.2026: у зошиті шиномонтажу 9 сум, у програмі 6 — повторний шиномонтаж у тому ж чеку мовчки замінював суму.
describe('a second tire charge in the same receipt', () => {
  it('adds to the amount already in the receipt by default, or replaces it when the cashier chooses so', async () => {
    const { tireChargeTotal } = await import('./quickChargeModel')
    expect(tireChargeTotal(10000, 190000, 'add')).toBe(200000)
    expect(tireChargeTotal(10000, 190000, 'replace')).toBe(190000)
    expect(tireChargeTotal(null, 190000, 'add')).toBe(190000)
    expect(() => tireChargeTotal(10000, 0, 'add')).toThrow('Вкажіть суму більше 0')
    expect(() => tireChargeTotal(10000, Number.NaN, 'add')).toThrow('Вкажіть суму більше 0')
  })

  it('the till never replaces silently and shows the final amount with the master', async () => {
    const { readFileSync } = await import('node:fs')
    const modal = readFileSync(new URL('./QuickChargeModal.tsx', import.meta.url), 'utf8')
    expect(modal).toContain("const [tireMode, setTireMode] = useState<TireChargeMode>('add')")
    expect(modal).toContain('tireChargeTotal(existingTire?.unitPrice, price, existingTire ? tireMode : \'replace\')')
    expect(modal).toContain('unitPrice: finalPrice,')
    expect(modal).toContain('У чеку вже є шиномонтаж:')
    expect(modal).toContain('`Шиномонтаж у чеку: ${formatMoney(finalPrice)}')
    expect(modal).not.toContain("toast.success('Позицію додано в чек')")
    // Один майстер на чек.
    expect(modal).toContain('У чеку шиномонтаж іншого майстра.')
  })
})
