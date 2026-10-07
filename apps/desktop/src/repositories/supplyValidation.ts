import { stockQuantity } from './stockQuantity'

/** Spelling only: an explicit 1:1 unit annotation is not a pack conversion. */
export function normalizeAiSupplyUnit(value: string): string {
  const clean = value.normalize('NFKC').trim().toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ').replace(/\.$/, '')
  const aliases: Record<string, string> = { pcs: 'шт', pc: 'шт', piece: 'шт', pieces: 'шт', штук: 'шт', штука: 'шт', штуки: 'шт', kg: 'кг', кілограм: 'кг', килограмм: 'кг', l: 'л', літр: 'л', литр: 'л', m: 'м', метр: 'м', комплект: 'компл', комплекти: 'компл', 'к-т': 'компл', уп: 'упак', упаковка: 'упак' }
  const canonical = (unit: string) => aliases[unit.trim().replace(/\.$/, '')] ?? unit.trim().replace(/\.$/, '')
  const one = clean.match(/^([^()]+)\(\s*1(?:[.,]0+)?\s+([^()]+)\)$/u)
  if (one && canonical(one[1]) === canonical(one[2])) return canonical(one[1])
  return canonical(clean)
}

/** Exact unit compatibility for AI receiving; never infer a pack multiplier. */
export function checkedAiSupplyUnit(value: unknown, catalogUnit: string | null | undefined, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(label + ': одиниця виміру має бути текстом.')
  const unit = normalizeAiSupplyUnit(value)
  if (!unit) return undefined
  if (catalogUnit !== undefined && unit !== normalizeAiSupplyUnit(catalogUnit || 'шт')) {
    throw new Error(label + ': одиниця виміру накладної «' + value + '», у картці «' + (catalogUnit || 'шт') + '». Перевірте кількість і закупівельну ціну в одиницях обліку; упаковки не перераховано автоматично.')
  }
  // A non-1:1 pack annotation cannot become a new accounting unit by accident.
  if (/[()]/.test(unit)) throw new Error(label + ': уточніть одиницю виміру «' + value + '». Кількість в упаковці не перераховується автоматично.')
  return unit
}

export function checkedAiSupplyQuantity(value: unknown): number {
  const text = String(value ?? '').trim().replace(',', '.')
  const qty = Number(text)
  if (!/^\d+(?:\.\d{1,3})?$/.test(text) || !Number.isFinite(qty) || qty <= 0) {
    throw new Error('Перевірте кількість — число більше нуля, до 3 знаків після коми. Нерозпізнане значення не замінюється на 1.')
  }
  return qty
}
export function checkedAiSupplyPrice(value: unknown): number {
  if (value == null || String(value).trim() === '') throw new Error('Не розпізнано закупівельну ціну. Перевірте накладну.')
  const normalized = typeof value === 'string' ? value.replace(/\s/g, '').replace(',', '.') : value
  if (typeof normalized !== 'string' && typeof normalized !== 'number') throw new Error('Перевірте закупівельну ціну')
  const amount = Number(normalized)
  if (!Number.isFinite(amount) || amount < 0 || Math.round(amount * 100) > MAX_SUPPLY_MONEY) throw new Error('Перевірте закупівельну ціну')
  return Math.round(amount * 100)
}

export const MAX_SUPPLY_MONEY = 2_147_483_647
export function checkedSupplyMoney(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}: вкажіть коректне число`)
  if (value < 0) throw new Error(`${label} не може бути від’ємною`)
  const normalized = Math.round(value)
  if (normalized > MAX_SUPPLY_MONEY) throw new Error(`${label} надто велика. Перевірте, чи штрихкод випадково не потрапив у поле ціни.`)
  return normalized
}
export function normalizeSupplyItem<T extends { qty: number; purchase_price: number; total?: number }>(item: T): T & { total: number } {
  const qty = stockQuantity(item.qty, 'Кількість у накладній має бути коректним числом до 3 знаків після коми')
  if (qty <= 0) throw new Error('Кількість у накладній має бути коректним числом більше нуля')
  const purchasePrice = checkedSupplyMoney(item.purchase_price, 'Ціна закупівлі')
  const total = checkedSupplyMoney(qty * purchasePrice, 'Сума позиції')
  if (item.total !== undefined && checkedSupplyMoney(item.total, 'Сума позиції') !== total)
    throw new Error('Сума позиції не відповідає кількості та ціні. Перевірте рядок накладної.')
  return { ...item, qty, purchase_price: purchasePrice, total }
}
