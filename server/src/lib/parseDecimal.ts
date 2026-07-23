/**
 * Розбирає число з довільного локального формату (ціни з накладних, Excel-експортів).
 *
 * Excel/SheetJS часто повертає число 1343.6 як "1,343.60" (кома — тисячі, крапка —
 * десяткова). Наївне `.replace(',', '.')` робить з коми тисяч другу крапку →
 * "1.343.60" → parseFloat обриває на 1.343. Тому десятковим роздільником вважаємо
 * ОСТАННЮ кому/крапку, а другий символ — розділювачем тисяч.
 */
export function parseLocaleNumber(raw: unknown): number {
  let s = String(raw ?? '').replace(/[^\d.,-]/g, '')
  if (!s) return Number.NaN
  const neg = s.startsWith('-')
  s = s.replace(/-/g, '')

  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) s = s.split('.').join('').replace(',', '.')
    else s = s.split(',').join('')
  } else if (lastComma >= 0) {
    const commaCount = (s.match(/,/g) || []).length
    const after = s.length - lastComma - 1
    if (commaCount > 1 || after === 3) s = s.split(',').join('')
    else s = s.replace(',', '.')
  } else if (lastDot >= 0) {
    const dotCount = (s.match(/\./g) || []).length
    if (dotCount > 1 || /^\d{1,3}\.\d{3}$/.test(s)) s = s.split('.').join('')
  }

  const value = Number.parseFloat(s)
  if (!Number.isFinite(value)) return Number.NaN
  return neg ? -value : value
}
