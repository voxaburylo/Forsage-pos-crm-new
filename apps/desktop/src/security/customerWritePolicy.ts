// Renderer input cannot choose the author or elevate a cashier's permissions.
export function customerWritePayload(input: Record<string, unknown>, session: { id: string; role: string }, current?: { loyalty_mode?: string }): Record<string, unknown> {
  const payload = { ...input, user_id: session.id }
  if (!['owner', 'admin', 'manager'].includes(session.role)) {
    if (input.discount_pct !== undefined && (session.role !== 'cashier' || current?.loyalty_mode === 'cashback')) {
      throw new Error('Налаштування накопичень клієнта змінює менеджер або адміністратор. Зміни не збережено.')
    }
    for (const key of ['bonus_balance', 'expected_bonus_balance', 'bonus_description', 'price_tier_id', 'client_status', 'loyalty_mode', 'vip_level', 'risk_profile']) {
      if (input[key] !== undefined) throw new Error('Бонуси та інші фінансові умови клієнта може змінювати лише власник, адміністратор або менеджер. Зміни не збережено.')
    }
  }
  return payload
}
