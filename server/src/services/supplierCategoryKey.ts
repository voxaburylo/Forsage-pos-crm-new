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
- Спершу шукай у цьому списку й відповідай номером.
- Якщо вид зрозумілий, але підхожої категорії в списку справді НЕМАЄ (рішення власника 27.11.2026: «якщо такої категорії немає — він її створює») — став -1 і в полі "new" запропонуй назву нової категорії: українською, 1–3 слова, загальна (вид товарів, не бренд, не модель авто, не розмір), у множині: «Кузовні деталі», «Системи кондиціонування». Не пропонуй нову, якщо товар можна розумно покласти в наявну.
- Якщо вид незрозумілий або приклади належать до різних категорій — став 0. Краще 0, ніж не та категорія: товар у чужій категорії на сайті гірший за товар без категорії.
- Дивись на приклади назв, а не лише на ключ: «ремінь» може бути поліклиновий, ГРМ або безпеки.
- Марка авто в назві — це застосовність, а не категорія.

КАТЕГОРІЇ МАГАЗИНУ:
${options.map((option, index) => `${index + 1}. ${option.path}`).join('\n')}

Відповідь — ЛИШЕ JSON: {"items":[{"n":<номер виду>,"c":<номер категорії, 0 або -1>,"new":"<назва нової категорії, лише коли c = -1>"}]}`
}

export function sortLine(n: number, key: string, samples: readonly string[]): string {
  const label = key.startsWith('cat:') ? 'категорія постачальника «' + key.slice(4) + '»' : 'назви починаються з «' + key.slice(5) + '»'
  return `№${n} | ${label} | приклади: ${samples.slice(0, 4).map(sample => sample.replace(/\s+/g, ' ').trim().slice(0, 110)).join(' ;; ')}`
}

export interface SortVote { c: number; name: string }
/** Назва нової категорії: коротка, українською, з великої літери; латиниця й цифри — ознака бренду чи моделі, таку не беремо. */
export function newCategoryName(raw: unknown): string {
  const name = String(raw ?? '').replace(/\s+/g, ' ').replace(/[«»"'.]+/g, '').trim()
  if (name.length < 3 || name.length > 60 || /[A-Za-z0-9]/.test(name) || !/^[А-ЯІЇЄҐа-яіїєґʼ’ ,-]+$/u.test(name)) return ''
  return name[0].toLocaleUpperCase('uk-UA') + name.slice(1)
}

/** Відповідь моделі → номер виду → рішення: номер категорії, 0 — не певен, -1 — потрібна нова категорія (з назвою). */
export function parseSortReply(reply: string, kinds: number, categories: number): Map<number, SortVote> {
  const out = new Map<number, SortVote>()
  const start = reply.indexOf('{'), end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return out
  let parsed: unknown
  try { parsed = JSON.parse(reply.slice(start, end + 1)) } catch { return out }
  const items = (parsed as { items?: unknown })?.items
  if (!Array.isArray(items)) return out
  for (const item of items) {
    const n = Number((item as { n?: unknown })?.n), c = Number((item as { c?: unknown })?.c)
    if (!Number.isInteger(n) || n < 1 || n > kinds || !Number.isInteger(c) || c < -1 || c > categories || out.has(n)) continue
    const name = c === -1 ? newCategoryName((item as { new?: unknown })?.new) : ''
    // «Нова» без придатної назви — це «не певен».
    out.set(n, c === -1 && !name ? { c: 0, name: '' } : { c, name })
  }
  return out
}

/**
 * Два незалежні рішення помічника про той самий вид. Категорія ставиться лише коли обидва збіглися; так само нова
 * категорія пропонується лише коли обидва сказали «потрібна нова» (назву потім зводить окремий крок). Розбіжність або
 * відсутня відповідь — «не певен». Так випадкова помилка однієї відповіді не розкладе сотні товарів не туди.
 */
export function agreedCategory(first: SortVote | undefined, second: SortVote | undefined): SortVote {
  if (!first || !second || first.c !== second.c) return { c: 0, name: '' }
  return first.c === -1 ? { c: -1, name: first.name } : { c: first.c, name: '' }
}

/** Скільки товарів має чекати на нову категорію, щоб її варто було створювати: одна категорія на пʼять товарів — це сміття в меню. */
export const NEW_CATEGORY_MIN_PRODUCTS = 15
export const NEW_CATEGORY_MAX_PER_RUN = 30

export function mergePrompt(options: readonly CategoryOption[]): string {
  return `Магазин автозапчастин «Форсаж». Для частини товарів постачальників у магазині немає підхожої категорії, і є пропозиції нових категорій (з кількістю товарів і прикладами). Зведи їх у МІНІМАЛЬНИЙ набір нових категорій.

Правила:
- Схожі пропозиції обʼєднуй в одну категорію («Кузовні деталі», «Кузовні запчастини», «Деталі кузова» → одна).
- Якщо пропозиція насправді підходить до вже наявної категорії магазину — вкажи її номер, нову не створюй.
- Назва нової категорії: українською, 1–3 слова, загальна (вид товарів, а не бренд, не модель авто, не розмір), у множині, як у наявних категоріях магазину.
- Пропозицію, яка надто вузька, незрозуміла чи стосується кількох різних видів, не включай нікуди — ці товари лишаться без категорії.

НАЯВНІ КАТЕГОРІЇ МАГАЗИНУ:
${options.map((option, index) => `${index + 1}. ${option.path}`).join('\n')}

Відповідь — ЛИШЕ JSON: {"groups":[{"name":"<назва нової категорії>","existing":0,"from":[<номери пропозицій>]},{"existing":<номер наявної категорії>,"from":[...]}]}`
}

export interface MergeGroup { name: string; existing: number; from: number[] }
/** Відповідь зведення. Кожна пропозиція — щонайбільше в одній групі; чужі номери, порожні й некоректні назви відкидаються. */
export function parseMergeReply(reply: string, proposals: number, categories: number): MergeGroup[] {
  const start = reply.indexOf('{'), end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try { parsed = JSON.parse(reply.slice(start, end + 1)) } catch { return [] }
  const groups = (parsed as { groups?: unknown })?.groups
  if (!Array.isArray(groups)) return []
  const used = new Set<number>(), out: MergeGroup[] = []
  for (const group of groups) {
    const existing = Number((group as { existing?: unknown })?.existing) || 0
    const name = existing > 0 ? '' : newCategoryName((group as { name?: unknown })?.name)
    const from = (Array.isArray((group as { from?: unknown })?.from) ? (group as { from: unknown[] }).from : []).map(Number)
      .filter(n => Number.isInteger(n) && n >= 1 && n <= proposals && !used.has(n))
    if (!from.length || existing < 0 || existing > categories || !Number.isInteger(existing) || (!existing && !name)) continue
    from.forEach(n => used.add(n))
    out.push({ name, existing, from })
  }
  return out
}
