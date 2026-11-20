import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'

vi.mock('./aiApi', () => ({ aiApi: { rules: vi.fn(() => new Promise(() => {})), addRule: vi.fn(), deleteRule: vi.fn() } }))
vi.mock('@/components/ui', () => ({ Button: ({ children }: { children: ReactNode }) => <button>{children}</button> }))
vi.mock('@/components/ui/Toast', () => ({ toast: { error: vi.fn() } }))
const { AiRulesCard } = await import('./AiRulesCard')

describe('AiRulesCard', () => {
  it('owner/admin get the add field and the chat hint', () => {
    const html = renderToStaticMarkup(<AiRulesCard canEdit />)
    expect(html).toContain('Правила помічника')
    expect(html).toContain('Забудь правило 2')
    expect(html).toContain('aria-label="Нове правило помічника"')
  })
  it('a cashier only reads the rules', () => {
    const html = renderToStaticMarkup(<AiRulesCard canEdit={false} />)
    expect(html).toContain('Правила помічника')
    expect(html).not.toContain('Нове правило помічника')
  })
})
