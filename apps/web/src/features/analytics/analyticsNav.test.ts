import { expect, it } from 'vitest'
import { activeAnalyticsLink, isAnalyticsPath, reportTabsInGroup, visibleAnalyticsGroups } from './analyticsNav'

it('groups reports in six sections and returns ABC and staff profitability to the menu', () => {
  expect(visibleAnalyticsGroups('owner').map(group => group.label)).toEqual(['Огляд', 'Продажі', 'Товари', 'Клієнти', 'Працівники', 'Контроль'])
  expect(isAnalyticsPath('/abc')).toBe(true)
  expect(isAnalyticsPath('/staff-analytics')).toBe(true)
  expect(isAnalyticsPath('/products')).toBe(false)
})

it('keeps role limits: a cashier sees only sold goods and tyre service', () => {
  const links = visibleAnalyticsGroups('cashier').flatMap(group => group.links.map(link => link.label))
  expect(links).toEqual(['Продані товари', 'Шиномонтаж'])
})

it('highlights the exact report and falls back to the page when the tab is not in the address', () => {
  const groups = visibleAnalyticsGroups('owner')
  expect(activeAnalyticsLink(groups, '/analytics/control', '?tab=stale')?.label).toBe('Залежані')
  expect(activeAnalyticsLink(groups, '/analytics/control', '')?.label).toBe('Закінчуються (за продажами)')
  expect(activeAnalyticsLink(groups, '/abc', '')?.label).toBe('ABC-аналіз')
})

it('limits the tabs inside a report to its own group', () => {
  expect(reportTabsInGroup('/analytics/sales', 'sold')).toEqual(['today', 'sold', 'profit'])
  expect(reportTabsInGroup('/analytics/sales', 'debtors')).toEqual(['debtors'])
  expect(reportTabsInGroup('/analytics/control', 'stale')).toEqual(['running', 'stale', 'below', 'low'])
  expect(reportTabsInGroup('/analytics/sales', null)).toBeNull()
})
