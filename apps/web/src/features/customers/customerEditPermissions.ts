export const CUSTOMER_FINANCIAL_ROLES = ['owner', 'admin', 'manager'] as const
export const CUSTOMER_CARD_EDITOR_ROLES = ['owner', 'admin', 'manager', 'cashier']

export function canEditCustomerCard(role: string | null | undefined): boolean {
  return CUSTOMER_CARD_EDITOR_ROLES.includes(role ?? '')
}

export function canManageCustomerFinancials(role: string | null | undefined): boolean {
  return CUSTOMER_FINANCIAL_ROLES.some((allowedRole) => allowedRole === role)
}

export function canManageCustomerDiscount(role: string | null | undefined, loyaltyMode = 'discount'): boolean {
  return canManageCustomerFinancials(role) || (role === 'cashier' && loyaltyMode !== 'cashback')
}

export function canManageCustomerStatus(role: string | null | undefined): boolean {
  return canManageCustomerFinancials(role) || role === 'cashier'
}

export function buildRoleSafeCustomerUpdate<
  TBasic extends Record<string, unknown>,
  TPrivileged extends Record<string, unknown>,
>(
  role: string | null | undefined,
  basic: TBasic,
  privileged: TPrivileged,
): TBasic | (TBasic & TPrivileged) {
  return canManageCustomerFinancials(role) ? { ...basic, ...privileged } : basic
}
