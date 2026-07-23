export const CUSTOMER_FINANCIAL_ROLES = ['owner', 'admin', 'manager'] as const

export function canManageCustomerFinancials(role: string | null | undefined): boolean {
  return CUSTOMER_FINANCIAL_ROLES.some((allowedRole) => allowedRole === role)
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
