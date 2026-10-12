import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const report = readFileSync(new URL('./DailyReport.tsx', import.meta.url), 'utf8')
const dashboard = readFileSync(new URL('../../pages/DashboardPage.tsx', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../settings/SettingsPage.tsx', import.meta.url), 'utf8')

describe('existing report and save scopes stay explicit', () => {
  it('groups only the three summary periods, retaining every distinct report branch', () => {
    const tabs = report.slice(report.indexOf('const TABS ='), report.indexOf('function selectReport'))
    expect(tabs).toContain("label: 'Підсумки'")
    expect(tabs).not.toMatch(/id: '(?:weekly|period)'/)
    for (const tab of ['today', 'weekly', 'period']) {
      expect(report).toContain(`value="${tab}"`)
      expect(report).toContain(`tab === '${tab}'`)
    }
    expect(report).toContain('aria-label="Період підсумків"')
    expect(report).toContain('setSummaryPeriod(next); setTab(next)')
    expect(report).toContain('setDateFrom(')
    expect(report).toContain('setDateTo(')
    expect(report).toContain('report.payment_received_total')
    expect(report).toContain('report.by_method.account')
    expect(report).toContain('periodReportNote')
  })
  it('shows revenue once on the overview without removing inventory or date selection', () => {
    expect(dashboard.match(/d\?\.total_revenue/g)).toHaveLength(1)
    expect(dashboard).toContain('retail_value')
    expect(dashboard).toContain('purchase_value')
    expect(dashboard).toContain('type="date"')
  })
  it('keeps one sold-items table and opens its unfiltered current-day context from the summary', () => {
    const today = report.slice(report.indexOf('{/* Сьогодні */}'), report.indexOf('{/* Продані товари за вибраний період'))
    expect(today).not.toContain('<table')
    expect(today).not.toContain('<SoldItemsMobile')
    expect(report.match(/<SoldItemsMobile items=\{soldItems\}/g)).toHaveLength(1)
    expect(today).toContain('onClick={openTodaysSoldItems}')
    expect(today).toContain('report.payment_received_total')
    expect(today).toContain('report.by_method.cash')
    const open = report.slice(report.indexOf('function openTodaysSoldItems()'), report.indexOf('const weeklyTotal'))
    expect(open).toContain('const date = businessDateKey()')
    expect(open).toContain('setSoldFrom(date); setSoldTo(date)')
    expect(open).toContain("setSoldSupplierId(''); setSoldSellerId(''); setSoldSearch('')")
    expect(open).toContain("setTab('sold')")
    expect(report).toContain("tab === 'today' ? todayKey : soldFrom")
  })
  it('names shop, AI and local-device saves separately and protects unsaved drafts', () => {
    expect(settings).toContain('Зберегти налаштування магазину')
    expect(settings).toContain('Зберегти налаштування ШІ')
    expect(settings).toContain('Вибір принтера зберігається одразу на цьому ПК')
    expect(settings).toContain('Перевірка каталогу')
    expect(settings).toContain('useUnsavedChanges(')
    expect(settings).toContain('setSettingsSnapshot(JSON.stringify(form))')
    expect(settings).toContain('setSellerSnapshot(JSON.stringify(seller))')
  })
})
