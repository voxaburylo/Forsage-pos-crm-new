import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { sourceForPaymentMethod, methodForPaymentSource } from './supplierPaymentSelection'
import type { InvoiceFundSource, InvoicePaymentMethod } from './invoiceFormModel'

describe('supplier payment selections', () => {
  it.each(['cashbox', 'split_cashbox_owner'] as const)('moves %s to the appropriate noncash source', source => {
    expect(sourceForPaymentMethod('card', source)).toBe('business_card')
    expect(sourceForPaymentMethod('transfer', source)).toBe('bank_account')
    expect(sourceForPaymentMethod('cash', source)).toBe(source)
  })
  it.each(['owner_funds', 'bank_account', 'business_card'] as const)('preserves explicitly selected %s', source => {
    for (const method of ['cash', 'card', 'transfer'] as const) expect(sourceForPaymentMethod(method, source)).toBe(source)
  })
  it.each(['cashbox', 'split_cashbox_owner'] as const)('makes an explicit %s selection cash', source => {
    expect(methodForPaymentSource(source, 'card')).toBe('cash')
    expect(methodForPaymentSource(source, 'transfer')).toBe('cash')
  })
  it('preserves a noncash method when selecting own funds', () => {
    expect(methodForPaymentSource('owner_funds', 'card')).toBe('card')
    expect(methodForPaymentSource('owner_funds', 'transfer')).toBe('transfer')
  })
  it.each(['InvoiceDetailPage.tsx', 'InvoiceFormPage.tsx'])('wires both existing fields in %s', file => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    expect(source).toContain('setFundSource(sourceForPaymentMethod(next, fundSource))')
    expect(source).toContain('setPaymentMethod(methodForPaymentSource(next, paymentMethod))')
  })
  it('never leaves a card/transfer tied to cash after alternating selections', () => {
    let method: InvoicePaymentMethod = 'cash', source: InvoiceFundSource = 'cashbox'
    for (const next of ['card', 'transfer', 'cash', 'card'] as const) {
      method = next; source = sourceForPaymentMethod(method, source)
      expect(method !== 'cash' && (source === 'cashbox' || source === 'split_cashbox_owner')).toBe(false)
      source = 'split_cashbox_owner'; method = methodForPaymentSource(source, method)
      expect(method).toBe('cash')
    }
  })
})
