export function customerPhoneKey(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '')
  return digits.length === 10 && digits.startsWith('0') ? `38${digits}` : digits
}

export function validateCustomerChanges(input: Record<string, unknown>): void {
  if (input.phone !== undefined && !customerPhoneKey(input.phone)) throw new Error('Вкажіть номер телефону')
  if (input.discount_pct !== undefined && (!Number.isFinite(Number(input.discount_pct)) || Number(input.discount_pct) < 0 || Number(input.discount_pct) > 100)) {
    throw new Error('Процент клієнта має бути від 0 до 100')
  }
  if (input.bonus_balance !== undefined && (!Number.isSafeInteger(Number(input.bonus_balance)) || Number(input.bonus_balance) < 0)) {
    throw new Error('Вкажіть коректну суму бонусів')
  }
}
