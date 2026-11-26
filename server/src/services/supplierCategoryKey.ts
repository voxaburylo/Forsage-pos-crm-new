/**
 * «Вид товару» для розкладки товарів постачальників по наших категоріях (26.11.2026).
 * Помічник вирішує не про кожен із десятків тисяч товарів, а про вид: категорію постачальника («Повітряні фільтри») або
 * початок назви («свічка запалювання», «диск гальмівний»). Так швидше, однаково для всіх схожих товарів і працює для
 * нових надходжень без нового запиту до ШІ.
 */
const GENERIC = new Set(['під замовлення', 'інше', 'різне', 'без категорії', 'товари', 'запчастини', 'автозапчастини', 'прочее', 'разное'])
const CYRILLIC_WORD = /^[а-яіїєґё][а-яіїєґё'ʼ’-]*\.?$/u

export function categoryKey(offer: { name?: string | null; category_name?: string | null }): string | null {
  const source = String(offer.category_name ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (source.length >= 3 && !GENERIC.has(source)) return ('cat:' + source).slice(0, 200)
  const words: string[] = []
  for (const raw of String(offer.name ?? '').replace(/\([^)]*\)/g, ' ').split(/[\s,;/]+/).filter(Boolean)) {
    // Слово великими літерами — це вже марка чи модель (ВАЗ, ГАЗ, КАМАЗ), а не вид товару.
    if (raw.length >= 2 && raw === raw.toUpperCase() && raw !== raw.toLowerCase()) break
    const word = raw.toLowerCase()
    if (!CYRILLIC_WORD.test(word)) break
    words.push(word.replace(/\.$/, ''))
    // Два слова: «ремінь поліклиновий» і «ремінь грм» — різні види, а «крило пер лів» і «крило пер прав» — один.
    if (words.length === 2) break
  }
  const key = words.join(' ')
  return key.length >= 4 && words.some(word => word.length >= 4) ? ('name:' + key).slice(0, 200) : null
}

export interface CategoryOption { id: string; path: string }
/** «Фільтри › Повітряні» — щоб помічник бачив, де категорія стоїть у дереві. */
export function categoryOptions(rows: ReadonlyArray<{ id: string; parent_id: string | null; name: string }>): CategoryOption[] {
  const byId = new Map(rows.map(row => [row.id, row]))
  const path = (row: { id: string; parent_id: string | null; name: string }, depth = 0): string =>
    row.parent_id && byId.has(row.parent_id) && depth < 6 ? path(byId.get(row.parent_id)!, depth + 1) + ' › ' + row.name : row.name
  return rows.map(row => ({ id: row.id, path: path(row) })).sort((a, b) => a.path.localeCompare(b.path, 'uk'))
}

export function sortPrompt(options: readonly CategoryOption[]): string {
  return `Ти розкладаєш товари постачальників автозапчастин по категоріях магазину «Форсаж». Нижче — категорії магазину з номерами. Для кожного ВИДУ товару (категорія постачальника або початок назви, з прикладами повних назв) вибери ОДНУ категорію магазину, куди такий товар поклав би досвідчений продавець запчастин.

Правила:
- Вибирай лише з цього списку, за номером. Нових категорій не вигадуй.
- Якщо підхожої категорії немає, вид незрозумілий або приклади належать до різних категорій — став 0. Краще 0, ніж не та категорія: товар у чужій категорії на сайті гірший за товар без категорії.
- Дивись на приклади назв, а не лише на ключ: «ремінь» може бути поліклиновий, ГРМ або безпеки.
- Марка авто в назві — це застосовність, а не категорія.

КАТЕГОРІЇ МАГАЗИНУ:
${options.map((option, index) => `${index + 1}. ${option.path}`).join('\n')}

Відповідь — ЛИШЕ JSON: {"items":[{"n":<номер виду>,"c":<номер категорії або 0>}]}`
}

export function sortLine(n: number, key: string, samples: readonly string[]): string {
  const label = key.startsWith('cat:') ? 'категорія постачальника «' + key.slice(4) + '»' : 'назви починаються з «' + key.slice(5) + '»'
  return `№${n} | ${label} | приклади: ${samples.slice(0, 4).map(sample => sample.replace(/\s+/g, ' ').trim().slice(0, 110)).join(' ;; ')}`
}

/** Відповідь моделі → номер виду → номер категорії (0 — не певен). Чужі номери й сміття відкидаються. */
export function parseSortReply(reply: string, kinds: number, categories: number): Map<number, number> {
  const out = new Map<number, number>()
  const start = reply.indexOf('{'), end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return out
  let parsed: unknown
  try { parsed = JSON.parse(reply.slice(start, end + 1)) } catch { return out }
  const items = (parsed as { items?: unknown })?.items
  if (!Array.isArray(items)) return out
  for (const item of items) {
    const n = Number((item as { n?: unknown })?.n), c = Number((item as { c?: unknown })?.c)
    if (Number.isInteger(n) && n >= 1 && n <= kinds && Number.isInteger(c) && c >= 0 && c <= categories && !out.has(n)) out.set(n, c)
  }
  return out
}

/**
 * Два незалежні рішення помічника про той самий вид. Категорія ставиться лише коли обидва збіглися; розбіжність або
 * відсутня відповідь — «не певен» (0). Так випадкова помилка однієї відповіді не розкладе сотні товарів не туди.
 */
export function agreedCategory(first: number | undefined, second: number | undefined): number {
  return first !== undefined && first === second ? first : 0
}
