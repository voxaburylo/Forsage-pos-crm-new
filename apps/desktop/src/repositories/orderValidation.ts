const MAX_ORDER_MONEY = 2_147_483_647
function isNumeric(value: unknown): boolean {
  return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
}
export function assertOrderTotal(value: number): void {
  if (!Number.isFinite(value) || value < 0 || Math.round(value) > MAX_ORDER_MONEY)
    throw new Error('Сума замовлення завелика або некоректна. Перевірте кількість і ціни.')
}
export function assertOrderItemAmounts(item: { qty?: unknown; sell_price?: unknown; buy_price?: unknown; core_deposit_amount?: unknown }): void {
  const quantity = Number(item.qty)
  if (!isNumeric(item.qty) || !Number.isFinite(quantity) || quantity <= 0 || quantity > Number.MAX_SAFE_INTEGER)
    throw new Error('Вкажіть додатну кількість та невід’ємну ціну позиції')
  for (const value of [item.sell_price, item.buy_price ?? 0, item.core_deposit_amount ?? 0]) {
    if (!isNumeric(value) || !Number.isFinite(Number(value)) || Number(value) < 0)
      throw new Error('Вкажіть додатну кількість та невід’ємну ціну позиції')
    assertOrderTotal(Number(value))
    assertOrderTotal(quantity * Number(value))
  }
}
