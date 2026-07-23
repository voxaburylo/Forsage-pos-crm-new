/**
 * Розбирає число з довільного локального формату (ціни з накладних, Excel-експортів тощо).
 *
 * Проблема, яку це вирішує: коли Excel читається через SheetJS з `raw:false`,
 * число 1343.6 повертається у вигляді рядка "1,343.60" (кома — розділювач тисяч,
 * крапка — десяткова). Наївне `.replace(',', '.')` перетворює кому тисяч на другу
 * крапку → "1.343.60" → parseFloat обриває на 1.343. Тому визначаємо десятковий
 * роздільник як ОСТАННЮ кому/крапку, а другий символ трактуємо як розділювач тисяч.
 *
 * Підтримує: "1,343.60", "1.343,60", "1 343,60", "1 234 567,89", "315,40",
 * "315.40", "1,343" (тисячі), "₴ 1 999,00", "-15,5".
 */
export function parseLocaleNumber(raw: unknown): number {
  let s = String(raw ?? '').replace(/[^\d.,-]/g, '')
  if (!s) return Number.NaN
  const neg = s.startsWith('-')
  s = s.replace(/-/g, '')

  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')

  if (lastComma >= 0 && lastDot >= 0) {
    // Обидва роздільники присутні — той, що правіше, і є десятковим.
    if (lastComma > lastDot) s = s.split('.').join('').replace(',', '.')
    else s = s.split(',').join('')
  } else if (lastComma >= 0) {
    // Лише коми. Кілька ком або рівно 3 цифри після — це розділювач тисяч.
    const commaCount = (s.match(/,/g) || []).length
    const after = s.length - lastComma - 1
    if (commaCount > 1 || after === 3) s = s.split(',').join('')
    else s = s.replace(',', '.')
  } else if (lastDot >= 0) {
    // Лише крапки. Кілька крапок або згрупований вигляд "1.234" — розділювач тисяч.
    const dotCount = (s.match(/\./g) || []).length
    if (dotCount > 1 || /^\d{1,3}\.\d{3}$/.test(s)) s = s.split('.').join('')
  }

  const value = Number.parseFloat(s)
  if (!Number.isFinite(value)) return Number.NaN
  return neg ? -value : value
}
