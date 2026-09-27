export const MAX_SUPPLY_MONEY = 2_147_483_647
export function checkedSupplyMoney(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}: вкажіть коректне число`)
  if (value < 0) throw new Error(`${label} не може бути від’ємною`)
  const normalized = Math.round(value)
  if (normalized > MAX_SUPPLY_MONEY) throw new Error(`${label} надто велика. Перевірте, чи штрихкод випадково не потрапив у поле ціни.`)
  return normalized
}
export function normalizeSupplyItem<T extends { qty: number; purchase_price: number; total?: number }>(item: T): T & { total: number } {
  if (typeof item.qty !== 'number' || !Number.isFinite(item.qty) || item.qty <= 0 || item.qty > Number.MAX_SAFE_INTEGER)
    throw new Error('Кількість у накладній має бути коректним числом більше нуля')
  const purchasePrice = checkedSupplyMoney(item.purchase_price, 'Ціна закупівлі')
  const total = checkedSupplyMoney(item.qty * purchasePrice, 'Сума позиції')
  if (item.total !== undefined && checkedSupplyMoney(item.total, 'Сума позиції') !== total)
    throw new Error('Сума позиції не відповідає кількості та ціні. Перевірте рядок накладної.')
  return { ...item, purchase_price: purchasePrice, total }
}
