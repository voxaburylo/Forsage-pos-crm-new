import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { expectedDate, looksLikeArticle } from './SupplierOfferSuggestions'
import { isAssistantPath } from '@/lib/assistantViaMainPc'
import { SETTINGS_TABS } from '@/features/settings/SettingsTabs'

// 24.11.2026 (слово власника): товари постачальників з API у бланку замовлення — за артикулом.
describe('supplier offers in the order form', () => {
  it('asks suppliers only for something that looks like an article', () => {
    for (const yes of ['36489', 'KCF-8113-C', '0 986 452 041', 'BKR6E-11']) expect(looksLikeArticle(yes), yes).toBe(true)
    for (const no of ['фі', 'фильтр салона', 'колодки передні Ланос', 'ab']) expect(looksLikeArticle(no), no).toBe(false)
  })
  it('expected date is today plus days to ship; no days — empty', () => {
    expect(expectedDate(3, new Date(2026, 10, 24, 15))).toBe('2026-11-27')
    expect(expectedDate(10, new Date(2026, 11, 28))).toBe('2027-01-07')
    expect(expectedDate(null)).toBe('')
  })
  it('on the main PC the search goes with the PC key; the owner has a tab for supplier keys', () => {
    expect(isAssistantPath('/api/v1/supplier-offers/search?q=36489')).toBe(true)
    expect(isAssistantPath('/api/v1/supplier-api')).toBe(true)
    expect(isAssistantPath('/api/v1/supplier-offersx')).toBe(false)
    expect(SETTINGS_TABS.some(tab => tab.label === 'API-ключі')).toBe(true)
    const form = readFileSync(new URL('./OrderFormPage.tsx', import.meta.url), 'utf8')
    expect(form).toContain('<SupplierOfferSuggestions query={search} onPick={addSupplierOffer}')
    // Товар постачальника не стає карткою складу: у рядку немає product_id, лише «під замовлення».
    expect(form).toMatch(/function addSupplierOffer[\s\S]{0,400}source_type: 'supplier'/)
  })
})
