import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CustomerCardBarcodeField, preventCardScanSubmit } from './CustomerCardBarcodeField'
import { canEditCustomerCard, canManageCustomerFinancials } from './customerEditPermissions'

describe('existing customer card input', () => {
  it('keeps leading zeros and makes manual/scanner input explicit', () => {
    const html = renderToStaticMarkup(<CustomerCardBarcodeField value="0001234567" onChange={() => {}} />)
    expect(html).toContain('type="text"')
    expect(html).toContain('value="0001234567"')
    expect(html).toContain('код своєї картки')
    expect(html).toMatch(/<button[^>]*disabled=""/)
    expect(html).toContain('min-w-0')
  })
  it('only allows generation while the card field is empty', () => {
    const html = renderToStaticMarkup(<CustomerCardBarcodeField value="" onChange={() => {}} />)
    expect(html).not.toContain('disabled=""')
  })
  it('blocks scanner Enter from submitting or triggering the POS keyboard handler', () => {
    const event = { key: 'Enter', preventDefault: vi.fn(), stopPropagation: vi.fn() }
    preventCardScanSubmit(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    event.key = '1'
    preventCardScanSubmit(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
  it('uses the same input in both create forms and the editor', () => {
    for (const file of ['CustomerFormPage.tsx', 'QuickCustomerModal.tsx', 'QuickCustomerEditModal.tsx']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toContain('<CustomerCardBarcodeField')
    }
  })
  it('allows cashier card editing but not financial administration', () => {
    expect(canEditCustomerCard('cashier')).toBe(true)
    expect(canManageCustomerFinancials('cashier')).toBe(false)
    expect(canEditCustomerCard('tire_worker')).toBe(false)
    expect(canEditCustomerCard(undefined)).toBe(false)
    const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
    expect(app).toMatch(/path="\/customers\/:id\/edit"[^\n]*roles=\{CUSTOMER_CARD_EDITOR_ROLES\}/)
  })
})
