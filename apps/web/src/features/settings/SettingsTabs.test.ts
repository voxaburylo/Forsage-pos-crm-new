import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OLD_SETTINGS_TABS, SETTINGS_TABS, resolveSettingsTab, settingsSectionVisible } from './SettingsTabs'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

it('shows a block on its own tab, and anywhere when the search matches', () => {
  const block = { tab: 'till' as const, title: 'Фіскалізація ПРРО каса чек' }
  expect(settingsSectionVisible(block, 'till', '')).toBe(true)
  expect(settingsSectionVisible(block, 'shop', '')).toBe(false)
  expect(settingsSectionVisible(block, 'shop', 'прро')).toBe(true)
  expect(settingsSectionVisible(block, 'till', 'націнка')).toBe(false)
})

// 23.11.2026 (план B4, слово власника: «багато підвкладок… упорядкувати»).
describe('settings layout: six tabs by meaning', () => {
  const page = read('./SettingsPage.tsx')
  const sections = [...page.matchAll(/<SettingsSection tab="([a-z]+)"( rare)? title="([^"]*)"\s+hint="([^"]*)">/g)]
    .map(match => ({ tab: match[1], rare: Boolean(match[2]), title: match[3], hint: match[4] }))

  it('six tabs instead of eight', () => {
    expect(SETTINGS_TABS.map(tab => tab.label)).toEqual(['Магазин', 'Ціни і знижки', 'Каса і друк', 'Telegram', 'ПК і копії', 'ШІ'])
  })

  it('every block is on a real tab and says in one line what it is for', () => {
    expect(sections).toHaveLength(25)
    expect(page.match(/<SettingsSection /g)).toHaveLength(25)
    const known = new Set<string>([...SETTINGS_TABS.map(tab => tab.id), 'catalog', 'audit'])
    for (const section of sections) {
      expect(known.has(section.tab), section.title).toBe(true)
      expect(section.hint.length, section.title).toBeGreaterThan(20)
      expect(section.hint.length, section.title).toBeLessThan(140)
    }
    // Жодна видима вкладка не лишилась порожньою.
    for (const tab of SETTINGS_TABS) expect(sections.some(section => section.tab === tab.id && !section.rare), tab.label).toBe(true)
  })

  it('everything about Telegram is on one tab, everything about this computer and copies on another', () => {
    const tabOf = (start: string) => sections.find(section => section.title.startsWith(start))?.tab
    expect(tabOf('Повідомлення Telegram')).toBe('telegram')
    expect(tabOf('Канали шаблони')).toBe('telegram')
    for (const start of ['Резервні копії', 'Копії на флешку', 'Копія на сервері', 'Локальна мережа', 'Журнал проблем', 'Локальна база', 'Відновлення з хмарної', 'Полегшений режим']) expect(tabOf(start), start).toBe('pc')
    for (const start of ['Матриця націнок', 'Правила продажу', 'Правила повернення', 'Швидкі відсотки', 'Знижка для працівників']) expect(tabOf(start), start).toBe('prices')
    expect(tabOf('Декодер VIN')).toBe('ai')
    expect(tabOf('Основна інформація')).toBe('shop')
    expect(tabOf('Реквізити продавця')).toBe('shop')
  })

  it('rare and dangerous blocks stay folded until asked for, but the search finds them', () => {
    expect(sections.filter(section => section.rare).map(section => section.title.slice(0, 20))).toEqual(['Відновлення з хмарно', 'Полегшений режим ста'])
    const restore = { tab: 'pc' as const, title: 'Відновлення з хмарної копії', rare: true }
    expect(settingsSectionVisible(restore, 'pc', '')).toBe(false)
    expect(settingsSectionVisible(restore, 'pc', '', true)).toBe(true)
    expect(settingsSectionVisible(restore, 'shop', 'відновлення')).toBe(true)
    expect(settingsSectionVisible(restore, 'shop', '', true)).toBe(false)
    // Кнопка «Рідко потрібне» стоїть перед рідкісними блоками — тобто внизу вкладки.
    expect(page.indexOf("<SettingsRareToggle tabs={['pc']} />")).toBeGreaterThan(page.indexOf('title="Локальна мережа'))
    expect(page.indexOf("<SettingsRareToggle tabs={['pc']} />")).toBeLessThan(page.indexOf('title="Відновлення з хмарної'))
  })

  it('old links and bookmarks lead to the new tabs', () => {
    expect(OLD_SETTINGS_TABS).toEqual({ products: 'prices', sales: 'prices', notifications: 'telegram', network: 'pc', service: 'pc' })
    for (const [old, next] of Object.entries(OLD_SETTINGS_TABS)) expect(resolveSettingsTab(old)).toBe(next)
    for (const tab of SETTINGS_TABS) expect(resolveSettingsTab(tab.id)).toBe(tab.id)
    for (const bad of [null, undefined, '', 'nope', '<script>']) expect(resolveSettingsTab(bad)).toBeNull()
  })

  it('dictionaries and the audit log left the tabs: they open from «Товари» and «Контроль» and by search', () => {
    expect(sections.find(section => section.title.startsWith('Категорії бренди'))?.tab).toBe('catalog')
    expect(sections.find(section => section.title.startsWith('Журнал аудиту'))?.tab).toBe('audit')
    expect(SETTINGS_TABS.some(tab => (tab.id as string) === 'catalog' || (tab.id as string) === 'audit')).toBe(false)
    expect(resolveSettingsTab('catalog')).toBe('catalog')
    expect(read('../products/ProductsPage.tsx')).toContain("navigate('/settings?tab=catalog')")
    expect(read('../analytics/ControlReportPage.tsx')).toContain('<Link to="/audit"')
    expect(settingsSectionVisible({ tab: 'catalog', title: 'Категорії бренди довідники товарів' }, 'shop', 'бренд')).toBe(true)
  })

  it('the save button shows only on tabs that have shop form fields', () => {
    expect(page).toContain("<SettingsFormOnly tabs={['shop', 'prices', 'till', 'telegram', 'ai']}>")
  })
})
