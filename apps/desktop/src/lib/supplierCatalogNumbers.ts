/**
 * Exact numbers for supplier price lists (not shop stock).
 * Kept identical in desktop/server/web: their standalone builds cannot import
 * each other's sources. A regression test verifies the three copies.
 * A single comma/dot is decimal; grouping must be explicit and well formed.
 */
const PRICE_MAX = 2147483647n // Existing PostgreSQL INTEGER column.
const UNITS_MAX = BigInt(Number.MAX_SAFE_INTEGER)
const QTY_ERROR = 'Некоректна кількість у прайсі: потрібне невід’ємне число, до 3 знаків після коми'
const PRICE_ERROR = 'Некоректна закупівельна ціна у прайсі: вкажіть суму до копійок, без зайвого тексту'

function decimalText(value: unknown, message: string): string {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'number' && !Number.isFinite(value))) throw new Error(message)
  let text = String(value).normalize('NFKC').trim()
  if (text.startsWith('+')) text = text.slice(1)
  if (!text || text.length > 80 || !/^[0-9., ]+$/.test(text)) throw new Error(message)
  const comma = text.lastIndexOf(','), dot = text.lastIndexOf('.')
  let integer = text, fraction = '', grouping = ''
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.'
    grouping = decimal === ',' ? '.' : ','
    const parts = text.split(decimal)
    if (parts.length !== 2) throw new Error(message)
    ;[integer, fraction] = parts
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? ',' : '.'
    const parts = text.split(separator)
    if (parts.length === 2) [integer, fraction] = parts
    else grouping = separator
  }
  if (grouping) {
    const groups = integer.split(grouping)
    if (groups.length < 2 || !/^[0-9]{1,3}$/.test(groups[0])
      || groups.slice(1).some(group => !/^[0-9]{3}$/.test(group))) throw new Error(message)
    integer = groups.join('')
  }
  if (integer.includes(' ')) {
    if (!/^[0-9]{1,3}(?: [0-9]{3})+$/.test(integer)) throw new Error(message)
    integer = integer.replace(/ /g, '')
  }
  if ((!integer && !fraction) || !/^[0-9]*$/.test(integer) || !/^[0-9]*$/.test(fraction))
    throw new Error(message)
  return (integer || '0') + (fraction ? '.' + fraction : '')
}

function scaledUnits(text: string, scale: number, max: bigint, message: string): bigint {
  const [integer, rawFraction = ''] = text.split('.')
  const fraction = rawFraction.replace(/0+$/, '')
  if (fraction.length > scale) throw new Error(message)
  const units = BigInt(integer) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0')
  if (units > max) throw new Error(message)
  return units
}
function quantityText(units: bigint): string {
  const remainder = (units % 1000n).toString().padStart(3, '0').replace(/0+$/, '')
  const text = (units / 1000n).toString() + (remainder ? '.' + remainder : '')
  // SQLite has numeric affinity: do not accept a value that loses thousandths there.
  if (String(Number(text)) !== text) throw new Error(QTY_ERROR)
  return text
}
export function catalogQuantity(value: unknown = 0): string {
  return quantityText(scaledUnits(decimalText(value, QTY_ERROR), 3, UNITS_MAX, QTY_ERROR))
}
export function addCatalogQuantity(left: unknown, right: unknown): string {
  const units = (value: unknown) => scaledUnits(catalogQuantity(value), 3, UNITS_MAX, QTY_ERROR)
  const sum = units(left) + units(right)
  if (sum > UNITS_MAX) throw new Error(QTY_ERROR)
  return quantityText(sum)
}
export function catalogPriceKopecks(value: unknown): number {
  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) value = Number(value)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > Number(PRICE_MAX))
    throw new Error(PRICE_ERROR)
  return value
}
export function catalogPriceFromHryvnia(value: unknown): number {
  if (typeof value === 'string') value = value.trim()
    .replace(/^(?:₴|UAH|грн\.?)\s*/i, '').replace(/\s*(?:₴|UAH|грн\.?)$/i, '')
  return Number(scaledUnits(decimalText(value, PRICE_ERROR), 2, PRICE_MAX, PRICE_ERROR))
}
