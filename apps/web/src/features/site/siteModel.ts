/**
 * Розділ «Сайт» (рішення власника 24.11.2026): власник сам керує тим, що бачить сайт магазину.
 * Сайт — окрема програма; він читає каталог із хмарної копії й передає замовлення в програму.
 * Ті самі поля й межі, що на сервері (server/src/services/siteService.ts).
 */
export type StockMode = 'hidden' | 'flag' | 'qty'
export interface SiteSettings {
  show_prices: boolean
  stock_mode: StockMode
  only_in_stock: boolean
  hidden_category_ids: string[]
  price_change_pct: number
  accept_orders: boolean
  min_order_kopecks: number
  title: string; phone: string; address: string; working_hours: string
  banner_text: string; about: string; delivery_text: string; payment_text: string
}
export interface SiteAdmin { enabled: boolean; settings: SiteSettings; key_hint: string | null; key_created_at: string | null; updated_at: string | null }
export interface SiteCategory { id: string; parent_id: string | null; name: string }
export interface SiteOrder {
  id: string; external_id: string; customer_name: string; customer_phone: string; delivery: string | null; comment: string | null
  items: Array<{ product_id: string; name: string; sku: string | null; qty: number; price: number }>
  total_amount: number; created_at: string; state: 'waiting' | 'in_program' | 'refused' | 'expired'; order_number: string | null; error: string | null
}

export const STOCK_MODE_TEXT: Record<StockMode, string> = {
  hidden: 'Не показувати наявність',
  flag: 'Лише «є / немає»',
  qty: 'Кількість штук',
}

export const ORDER_STATE_TEXT: Record<SiteOrder['state'], string> = {
  waiting: 'Чекає касу',
  in_program: 'У програмі',
  refused: 'Каса відмовила',
  expired: 'Каса не забрала за 7 днів',
}

/** «−10», «5,5» → число відсотків у межах −50…100; інакше — помилка зі зрозумілим текстом. */
export function readPercent(text: string): number {
  const value = text.trim().replace(',', '.').replace('−', '-')
  if (!value) return 0
  if (!/^-?\d{1,3}(?:\.\d{1,2})?$/.test(value)) throw new Error('Зміна ціни: введіть число відсотків, наприклад -5 або 10')
  const pct = Number(value)
  if (pct < -50 || pct > 100) throw new Error('Зміна ціни: від −50 до 100 відсотків')
  return pct
}

/** Гривні з поля → копійки; порожньо — 0 (без обмеження). */
export function readMinOrder(text: string): number {
  const value = text.trim().replace(',', '.')
  if (!value) return 0
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(value)) throw new Error('Найменша сума замовлення: введіть суму в гривнях, наприклад 300')
  return Math.round(Number(value) * 100)
}

export const money = (kopecks: number) => (kopecks / 100).toLocaleString('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' грн'

/** Приклад для власника: що стане з ціною 1 000 грн за вибраного відсотка. Нижче закупки сервер не опустить ніколи. */
export function priceExample(pct: number): string {
  const price = Math.ceil((100_000 * (100 + pct)) / 100 / 100) * 100
  return `Товар за 1 000 грн на сайті коштуватиме ${money(price)}`
}

/** Розділи деревом, у порядку показу: назва з відступом за рівнем. Розділ без знайденого «батька» — верхній. */
export function categoryRows(categories: SiteCategory[]): Array<{ id: string; name: string; depth: number }> {
  const ids = new Set(categories.map(category => category.id))
  const children = new Map<string | null, SiteCategory[]>()
  for (const category of categories) {
    const parent = category.parent_id && ids.has(category.parent_id) && category.parent_id !== category.id ? category.parent_id : null
    children.set(parent, [...(children.get(parent) ?? []), category])
  }
  const rows: Array<{ id: string; name: string; depth: number }> = []
  const seen = new Set<string>()
  const walk = (parent: string | null, depth: number) => {
    for (const category of children.get(parent) ?? []) {
      if (seen.has(category.id)) continue
      seen.add(category.id)
      rows.push({ id: category.id, name: category.name, depth })
      walk(category.id, depth + 1)
    }
  }
  walk(null, 0)
  // Замкнене коло «батьків» у даних — показуємо такі розділи верхніми, а не губимо.
  for (const category of categories) if (!seen.has(category.id)) rows.push({ id: category.id, name: category.name, depth: 0 })
  return rows
}
