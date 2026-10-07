import type { InvoiceFundSource, InvoicePaymentMethod } from './invoiceFormModel'

const usesCashbox = (source: InvoiceFundSource) => source === 'cashbox' || source === 'split_cashbox_owner'

/** Changing the method must not leave a hidden cash withdrawal selected. */
export function sourceForPaymentMethod<S extends InvoiceFundSource>(method: InvoicePaymentMethod, source: S): S | 'bank_account' | 'business_card' {
  if (method !== 'cash' && usesCashbox(source)) return method === 'card' ? 'business_card' : 'bank_account'
  return source
}

/** Choosing cashbox explicitly means actual cash, including a split payment. */
export function methodForPaymentSource(source: InvoiceFundSource, method: InvoicePaymentMethod): InvoicePaymentMethod {
  return usesCashbox(source) ? 'cash' : method
}
