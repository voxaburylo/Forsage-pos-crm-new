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

export type RoundDir = 'up' | 'down' | 'nearest'

export interface PriceRounding {
  enabled: boolean
  step: number // крок округлення в копійках: 50, 100, 500, 1000
  dir: RoundDir
}

/**
 * Округлює ціну (копійки) до кроку step у заданий бік.
 * Якщо округлення вимкнено або крок некоректний — повертає ціну без змін.
 */
export function roundToStep(price: number, rounding: PriceRounding | null | undefined): number {
  if (!rounding || !rounding.enabled) return price
  const step = Math.round(Number(rounding.step) || 0)
  if (step <= 0) return price
  const q = price / step
  const n = rounding.dir === 'up' ? Math.ceil(q)
    : rounding.dir === 'down' ? Math.floor(q)
    : Math.round(q)
  return n * step
}

/** Будує конфіг округлення з рядка shop_settings (безпечно до відсутніх колонок). */
export function roundingFromSettings(settings: any): PriceRounding | null {
  if (!settings) return null
  return {
    enabled: settings.price_rounding_enabled === true,
    step: Number(settings.price_rounding_step) || 0,
    dir: (settings.price_rounding_dir as RoundDir) || 'nearest',
  }
}

/**
 * Роздрібна ціна (копійки) за правилами націнки.
 * Якщо правило не знайдено — застосовує fallbackPct. Далі — округлення (якщо задано).
 */
export function applyMarkup(
  purchasePrice: number,
  rules: MarkupRule[] | undefined | null,
  fallbackPct: number,
  rounding?: PriceRounding | null,
): number {
  const pct = findMarkupPct(rules, purchasePrice) ?? fallbackPct
  const raw = Math.round(purchasePrice * (1 + pct / 100))
  return roundToStep(raw, rounding)
}
