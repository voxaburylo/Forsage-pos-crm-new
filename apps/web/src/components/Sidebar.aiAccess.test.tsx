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
  // 25.11.2026, слово власника: «вкладка “Перевірка каталогу” нам більше не потрібна — усе можемо зробити через ШІ».
  it('no «Перевірка каталогу» in the menu for anyone; its old link opens the AI assistant', () => {
    for (const role of ['owner', 'admin']) {
      state.role = role; state.desktop = true
      const html = render()
      expect(html).not.toContain('href="/ai-agent"')
      expect(html).not.toContain('Перевірка каталогу')
      expect(html).toContain('href="/ai-assistant"')
    }
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('<Route path="/ai-agent" element={<Navigate to="/ai-assistant" replace />} />')
    expect(app).not.toContain('CatalogAgentPage')
  })
  it('does not grant the cashier catalog-agent or settings navigation', () => {
    state.role = 'cashier'; state.desktop = true
    const html = render()
    expect(html).not.toContain('href="/ai-agent"')
    expect(html).not.toContain('href="/settings"')
  })
  it("a cashier in the web works on the till, not through the main PC", () => {
    state.role = 'cashier'; state.desktop = false
    expect(render()).not.toContain('href="/ai-assistant"')
  })
  it('uses the same assistant roles for direct URL access and keeps catalog maintenance restricted', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(source.match(/<Route path="\/ai-assistant"[^\n]+/)?.[0]).toContain('roles={AI_ASSISTANT_ROLES}')
    // «Перевірка каталогу» прибрана (25.11.2026): старе посилання лише веде до помічника, а там діють його ролі.
    expect(source.match(/<Route path="\/ai-agent"[^\n]+/)?.[0]?.trim()).toBe('<Route path="/ai-agent" element={<Navigate to="/ai-assistant" replace />} />')
  })
})
