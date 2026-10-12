import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import { ANALYTICS_TABS, FINANCE_TABS, SubNavTabs } from './SubNavTabs'

const state = vi.hoisted(() => ({ role: 'owner', desktop: true, offlineMode: false }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: (selector?: (value: unknown) => unknown) => {
  const value = { offlineMode: state.offlineMode, session: { user: { app_metadata: { role: state.role } } } }
  return selector ? selector(value) : value
} }))
vi.mock('@/lib/auth', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: {} }))
vi.mock('@/lib/desktopBridge', () => ({ isDesktopRuntime: () => state.desktop, desktopBridge: () => null }))

const sidebar = (location: string) => renderToStaticMarkup(<StaticRouter location={location}><Sidebar /></StaticRouter>)
const tabs = (items: typeof FINANCE_TABS, location = '/sales') => renderToStaticMarkup(
  <StaticRouter location={location}><SubNavTabs tabs={items} currentRole={state.role} /></StaticRouter>,
)
const anchor = (html: string, href: string) => [...html.matchAll(/<a\b[^>]*>/g)].map(match => match[0])
  .find(tag => tag.includes(`href="${href}"`)) ?? ''

describe('one destination per navigation choice', () => {
  beforeEach(() => { state.role = 'owner'; state.desktop = true; state.offlineMode = false })
  it.each(['/suppliers/invoices', '/suppliers/invoices/new', '/suppliers/invoices/invoice-1'])('only receiving is active at %s', location => {
    const html = sidebar(location)
    expect(anchor(html, '/suppliers/invoices')).toContain('aria-current="page"')
    expect(anchor(html, '/suppliers/invoices')).toContain('bg-yellow-50')
    expect(anchor(html, '/suppliers')).not.toContain('aria-current')
    expect(anchor(html, '/suppliers')).not.toContain('bg-yellow-50')
  })
  it('keeps supplier details within suppliers, not receiving', () => {
    const html = sidebar('/suppliers/supplier-1')
    expect(anchor(html, '/suppliers')).toContain('aria-current="page"')
    expect(anchor(html, '/suppliers/invoices')).not.toContain('aria-current')
  })
  it('offers analytics as a direct link without an identically named expander', () => {
    const html = sidebar('/products')
    expect(anchor(html, '/analytics')).toContain('href="/analytics"')
    expect(html.match(/Аналітика/g)).toHaveLength(1)
  })
  it('hides desktop-only finance tabs on the read-only web view', () => {
    state.desktop = false
    expect(tabs(FINANCE_TABS)).toBe('')
  })
  it('keeps all three local financial destinations with a precise journal label', () => {
    const html = tabs(FINANCE_TABS)
    expect(html).toContain('Журнал чеків')
    expect(html).toContain('href="/returns"')
    expect(html).toContain('href="/cashflow"')
  })
  it('retains manager report access without exposing payroll', () => {
    state.role = 'manager'; state.desktop = false
    const html = tabs(ANALYTICS_TABS, '/analytics/sales')
    expect(html).toContain('href="/analytics/statistics"')
    expect(html).toContain('Звіти про продажі')
    expect(html).not.toContain('/analytics/payroll')
  })
  it('does not display a redundant single report tab for a cashier', () => {
    state.role = 'cashier'
    expect(tabs(ANALYTICS_TABS, '/analytics/sales')).toBe('')
  })
})
