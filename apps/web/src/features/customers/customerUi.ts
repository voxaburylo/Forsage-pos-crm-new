export function mergeCustomerPage<T extends { id: string }>(previous: T[], next: T[]): T[] {
  const rows = new Map(previous.map((row) => [row.id, row]))
  for (const row of next) rows.set(row.id, row)
  return [...rows.values()]
}

export function parseCustomerMoney(value: string): number | null {
  const text = value.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null
  const amount = Math.round(Number(text) * 100)
  return Number.isSafeInteger(amount) ? amount : null
}

export function customerCashPath(id: string): string { return `/pos?customerMoney=${encodeURIComponent(id)}` }

export function customerMoneyLabel(method?: string | null): string {
  return ({ cash: 'Готівка', card: 'Картка', transfer: 'Переказ', cashback: 'Накопичення', order_cancel: 'Скасування замовлення', order_cancellation: 'Скасування замовлення', account: 'Рахунок клієнта' } as Record<string, string>)[method ?? ''] ?? 'Операція рахунку'
}
