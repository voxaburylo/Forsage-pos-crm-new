import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AI_ASSISTANT_ROLES } from '@/features/ai/aiAccess'
import { Sidebar } from './Sidebar'

const state = vi.hoisted(() => ({ role: 'cashier', desktop: true }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: () => ({ session: { user: { app_metadata: { role: state.role } } } }) }))
vi.mock('@/lib/auth', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: {} }))
vi.mock('@/lib/desktopBridge', () => ({ isDesktopRuntime: () => state.desktop, desktopBridge: () => null }))

const render = () => renderToStaticMarkup(<StaticRouter location="/ai-assistant"><Sidebar /></StaticRouter>)
describe('AI assistant navigation and role boundaries', () => {
  it.each(AI_ASSISTANT_ROLES)('shows assistant directly in the menu for %s', role => {
    state.role = role; state.desktop = true
    expect(render()).toContain('href="/ai-assistant"')
    expect(render()).toContain('ШІ-помічник')
  })
  it('does not grant the cashier catalog-agent or settings navigation', () => {
    state.role = 'cashier'; state.desktop = true
    const html = render()
    expect(html).not.toContain('href="/ai-agent"')
    expect(html).not.toContain('href="/settings"')
  })
  it('keeps the remote web viewer read-only', () => {
    state.role = 'cashier'; state.desktop = false
    expect(render()).not.toContain('href="/ai-assistant"')
  })
  it('uses the same assistant roles for direct URL access and keeps catalog maintenance restricted', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(source.match(/<Route path="\/ai-assistant"[^\n]+/)?.[0]).toContain('roles={AI_ASSISTANT_ROLES}')
    expect(source.match(/<Route path="\/ai-agent"[^\n]+/)?.[0]).toContain('roles={ADMIN_ROLES}')
  })
})
