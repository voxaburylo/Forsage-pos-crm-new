import { expect, it } from 'vitest'
import { settingsSectionVisible } from './SettingsTabs'

it('shows a block on its own tab, and anywhere when the search matches', () => {
  const block = { tab: 'till' as const, title: 'Фіскалізація ПРРО каса чек' }
  expect(settingsSectionVisible(block, 'till', '')).toBe(true)
  expect(settingsSectionVisible(block, 'shop', '')).toBe(false)
  expect(settingsSectionVisible(block, 'shop', 'прро')).toBe(true)
  expect(settingsSectionVisible(block, 'till', 'націнка')).toBe(false)
})
