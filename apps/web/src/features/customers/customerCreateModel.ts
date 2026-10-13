import { canManageCustomerDiscount, canManageCustomerFinancials } from './customerEditPermissions'

export type CustomerLoyaltyMode = 'discount' | 'cashback'

/** Search text is not necessarily a phone: never turn a name, VIN or SKU into contact data. */
export function customerPhoneFromSearch(value: string): string {
  const text = value.trim()
  if (!/^\+?[\d\s()-]+$/.test(text)) return ''
  const digits = text.replace(/\D/g, '')
  if (/^380\d{9}$/.test(digits)) return `+${digits}`
  if (/^0\d{9}$/.test(digits) && !text.startsWith('+')) return `+38${digits}`
  return ''
}

/** The UI must not confer financial rights just because creation exposes the existing selector. */
export function customerCreationLoyaltyPayload(role: string | null | undefined, draft: {
  discount_pct: string
  loyalty_mode: CustomerLoyaltyMode
  price_tier_id: string
}): { discount_pct?: number; loyalty_mode?: CustomerLoyaltyMode; price_tier_id?: string | null } {
  const canManageFinancials = canManageCustomerFinancials(role)
  const canManageDiscount = canManageCustomerDiscount(role)
  if (!canManageDiscount) return {}
  const discount = Number(draft.discount_pct.trim().replace(',', '.'))
  if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
    throw new Error('Відсоток має бути від 0 до 100%')
  }
  return {
    discount_pct: discount,
    ...(canManageFinancials ? {
      loyalty_mode: draft.loyalty_mode === 'cashback' ? 'cashback' : 'discount',
      price_tier_id: draft.price_tier_id || null,
    } : {}),
  }
}
