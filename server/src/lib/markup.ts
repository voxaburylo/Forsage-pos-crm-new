// Єдина логіка матриці націнок (раніше дублювалась у pricingService /
// productService / importService). Усі ціни — в копійках (INTEGER).

export interface MarkupRule {
  minPrice: number
  maxPrice: number
  markupPct: number
}

/**
 * % націнки за діапазоном закупівельної ціни (копійки).
 * Повертає null, якщо правил немає або жодне не підходить.
 */
export function findMarkupPct(
  rules: MarkupRule[] | undefined | null,
  purchasePrice: number,
): number | null {
  if (!rules || rules.length === 0) return null
  const rule = rules.find((r) => purchasePrice >= r.minPrice && purchasePrice < r.maxPrice)
  return rule ? rule.markupPct : null
}

/**
 * Роздрібна ціна (копійки) за правилами націнки.
 * Якщо правило не знайдено — застосовує fallbackPct.
 */
export function applyMarkup(
  purchasePrice: number,
  rules: MarkupRule[] | undefined | null,
  fallbackPct: number,
): number {
  const pct = findMarkupPct(rules, purchasePrice) ?? fallbackPct
  return Math.round(purchasePrice * (1 + pct / 100))
}
