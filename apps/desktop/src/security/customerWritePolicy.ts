// Renderer input cannot choose the author or elevate a cashier's permissions.
export function customerWritePayload(input: Record<string, unknown>, session: { id: string; role: string }): Record<string, unknown> {
  const payload = { ...input, user_id: session.id }
  if (!['owner', 'admin', 'manager'].includes(session.role)) {
    for (const key of ['discount_pct', 'bonus_balance', 'expected_bonus_balance', 'bonus_description', 'price_tier_id', 'client_status', 'loyalty_mode', 'vip_level', 'risk_profile']) {
      delete (payload as Record<string, unknown>)[key]
    }
  }
  return payload
}
