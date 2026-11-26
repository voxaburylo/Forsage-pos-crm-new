/**
 * Автоперевірка тексту товару перед записом на сайт (26.11.2026, слово власника: «великі пачки, без купи підтверджень,
 * тільки щоб він не робив дурниць»). Людина не читає тисячі описів — тож кожен текст проходить ці правила, і на сайт сам
 * іде лише той, де НЕМАЄ нічого, чого не було в даних товару. Решта відкладається «на перевірку» з причиною.
 *
 * Головне правило: модель не може додати факт. Кожне число й кожне слово латиницею (бренд, модель авто, стандарт) у тексті
 * мають бути в даних товару: назві, артикулі, бренді, категорії, характеристиках, номерах-аналогах.
 */
export interface ProductFacts {
  name: string; sku?: string | null; brand?: string | null; category?: string | null; unit?: string | null
  oem?: string | null; specs?: unknown; crosses?: readonly string[]
}
export interface TextFields { description: string; seo_title: string; seo_description: string; seo_keywords?: string }
export const TEXT_LIMITS = { descriptionMin: 150, descriptionMax: 1500, titleMin: 20, titleMax: 70, metaMin: 70, metaMax: 170 } as const

/** Загальновживані позначення, які не є фактом про конкретний товар. */
const COMMON_LATIN = new Set(['sae', 'api', 'acea', 'oem', 'oe', 'led', 'abs', 'esp', 'dot', 'iso', 'din', 'atf', 'suv', 'gps', 'usb', 'pvc', 'ok'])
/** Обіцянки, яких у даних товару немає: дозволені лише коли це слово вже є в даних. */
const PROMISES: Array<[RegExp, string]> = [
  [/гаранті/iu, 'гарантія'], [/сертиф/iu, 'сертифікат'], [/найкращ|найліпш|найнадійніш|найдешевш|№\s?1/iu, 'найкращий/найдешевший'],
  [/безкоштовн|безплатн/iu, 'безкоштовно'], [/знижк|акці[яї]|розпродаж/iu, 'знижка чи акція'], [/оригінал/iu, 'оригінал'],
  [/вироблен\p{L}*\s+(в|у)\s|країна\s+вироб/iu, 'країна виробництва'], [/термін\s+служб|ресурс\s+\d|до\s+\d+\s*(тис|км|рок)/iu, 'ресурс чи термін служби'],
]
const MONEY = /\d[\d\s.,]*\s?(грн|uah|₴)(?![\p{L}])/iu
const SECRET = /закупівельн|закупочн|закупк|собівартіст|себестоимост|націнк|наценк|постачальник/iu
const RUSSIAN = /[ыэъё]/iu

const flat = (value: unknown, depth = 0): string => value == null || depth > 4 ? '' : typeof value === 'object'
  ? Object.entries(value as Record<string, unknown>).map(([key, item]) => key + ' ' + flat(item, depth + 1)).join(' ') : String(value)
export function factsText(facts: ProductFacts): string {
  return [facts.name, facts.sku, facts.brand, facts.category, facts.unit, facts.oem, flat(facts.specs), ...(facts.crosses ?? [])].filter(Boolean).join(' ')
}
/** Число без розділювачів і хвостових нулів: «5,0» = «5», «1 000» = «1000». */
const numberKey = (value: string) => value.replace(/\s/g, '').replace(',', '.').replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
export function numbersIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\d+(?:[.,]\d+)?/g)].map(match => numberKey(match[0])))]
}
const UNITS: Record<string, string> = {
  л: 'л', l: 'л', літр: 'л', літри: 'л', літрів: 'л', литр: 'л', мл: 'мл', ml: 'мл', кг: 'кг', kg: 'кг', г: 'г', гр: 'г', g: 'г',
  мм: 'мм', mm: 'мм', см: 'см', cm: 'см', м: 'м', m: 'м', в: 'в', v: 'в', вольт: 'в', а: 'а', a: 'а', ампер: 'а', аг: 'аг', ач: 'аг', ah: 'аг',
  вт: 'вт', w: 'вт', шт: 'шт', pcs: 'шт', штук: 'шт', штуки: 'шт', км: 'км', km: 'км', бар: 'бар', bar: 'бар', дюйм: 'дюйм', дюймів: 'дюйм',
}
/** «5 л», «600мм», «12 V» → «5:л», «600:мм», «12:в». Літера після числа без пробілу, за якою йдуть ще знаки (5W-40), — не одиниця. */
export function measuresIn(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/(\d+(?:[.,]\d+)?)\s?([\p{L}]{1,6})(?![\p{L}\p{N}-])/gu)) {
    const unit = UNITS[match[2].toLowerCase()]
    if (unit) found.add(numberKey(match[1]) + ':' + unit)
  }
  return [...found]
}
export function latinWordsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[-'][A-Za-z0-9]+)*/g)].map(match => match[0].toLowerCase()))].filter(word => word.length >= 2)
}

/** Порожній масив — текст чистий, можна писати на сайт без людини. Інакше — причини простими словами. */
export function guardProductText(facts: ProductFacts, fields: TextFields): string[] {
  const problems: string[] = []
  const all = [fields.description, fields.seo_title, fields.seo_description, fields.seo_keywords ?? ''].join(' \n ')
  const source = factsText(facts), sourceLower = source.toLowerCase()
  const length = (label: string, value: string, min: number, max: number) => {
    if (value.length < min) problems.push(`${label} закороткий (${value.length} знаків)`)
    else if (value.length > max) problems.push(`${label} задовгий (${value.length} знаків)`)
  }
  length('опис', fields.description, TEXT_LIMITS.descriptionMin, TEXT_LIMITS.descriptionMax)
  length('заголовок для пошуковика', fields.seo_title, TEXT_LIMITS.titleMin, TEXT_LIMITS.titleMax)
  length('опис для пошуковика', fields.seo_description, TEXT_LIMITS.metaMin, TEXT_LIMITS.metaMax)
  if (MONEY.test(all)) problems.push('у тексті є ціна')
  if (SECRET.test(all)) problems.push('згадано закупівлю, націнку чи постачальника')
  // Російське слово з самої назви товару (бренд, модель) — не помилка; нове російське слово в тексті — так.
  if ((all.match(/\p{L}+/gu) ?? []).some(word => RUSSIAN.test(word) && !sourceLower.includes(word.toLowerCase()))) problems.push('текст не українською')
  const known = new Set(numbersIn(source))
  // Номери-аналоги й артикули пишуть з розділювачами по-різному: порівнюємо ще й «суцільні» цифри.
  const digitsOnly = source.replace(/[^\d]/g, ' ').split(/\s+/).filter(Boolean)
  const glued = source.replace(/[\s./_-]/g, '')
  // Довге число (від 4 цифр) може бути шматком артикула, записаного з розділювачами; коротке має збігтися точно.
  const invented = numbersIn(all).filter(number => !known.has(number) && !digitsOnly.includes(number.replace('.', '')) && !(number.replace('.', '').length >= 4 && glued.includes(number.replace('.', ''))))
  if (invented.length) problems.push('числа, яких немає в даних товару: ' + invented.slice(0, 5).join(', '))
  // Число з одиницею («5 л», «600 мм», «12 В») має стояти в даних саме з цією одиницею: «5» із «5W-40» не робить каністру пʼятилітровою.
  const wrongMeasures = measuresIn(all).filter(measure => !measuresIn(source).includes(measure))
  if (wrongMeasures.length) problems.push('розмір чи обʼєм, якого немає в даних товару: ' + wrongMeasures.slice(0, 5).map(measure => measure.replace(':', ' ')).join(', '))
  const strangers = latinWordsIn(all).filter(word => !COMMON_LATIN.has(word) && !sourceLower.includes(word))
  if (strangers.length) problems.push('назви, яких немає в даних товару: ' + strangers.slice(0, 5).join(', '))
  for (const [pattern, label] of PROMISES) if (pattern.test(all) && !pattern.test(source)) problems.push('обіцянка, якої немає в даних: ' + label)
  if (fields.description && fields.seo_description && fields.description.trim() === fields.seo_description.trim()) problems.push('опис і опис для пошуковика однакові')
  return problems
}

/** Відповідь моделі: {"items":[{"n":1,"description":"…","seo_title":"…","seo_description":"…"}]}. Зайвий текст навколо JSON ігнорується. */
export function parseTextReply(reply: string, allowed: ReadonlySet<number>): Map<number, TextFields> {
  const out = new Map<number, TextFields>()
  const start = reply.indexOf('{'), end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return out
  let parsed: unknown
  try { parsed = JSON.parse(reply.slice(start, end + 1)) } catch { return out }
  const items = (parsed as { items?: unknown })?.items
  if (!Array.isArray(items)) return out
  const clean = (value: unknown, oneLine: boolean) => typeof value === 'string' ? (oneLine ? value.replace(/\s+/g, ' ') : value.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')).trim() : ''
  for (const item of items) {
    const n = Number((item as { n?: unknown })?.n)
    if (!Number.isInteger(n) || !allowed.has(n) || out.has(n)) continue
    const row = item as Record<string, unknown>
    const keywords = clean(row.seo_keywords, true).split(',').map(part => part.trim()).filter(part => part.length >= 2 && part.length <= 60).slice(0, 8).join(', ')
    out.set(n, { description: clean(row.description, false), seo_title: clean(row.seo_title, true), seo_description: clean(row.seo_description, true), ...(keywords ? { seo_keywords: keywords } : {}) })
  }
  return out
}

export function textJobPrompt(styleNote: string | null): string {
  return `Ти пишеш тексти для сторінок товарів інтернет-магазину автозапчастин і шин «Форсаж» (Україна), щоб сторінку знаходили в Google і покупець розумів, що це і чи йому підходить.

Для КОЖНОГО товару зі списку поверни три тексти українською:
- description — опис для сторінки, ${TEXT_LIMITS.descriptionMin + 100}–700 знаків, 3–5 речень звичайною мовою: що це за товар, для чого він, що видно з його даних (бренд, розмір, обʼєм, вʼязкість, сторона, комплектність, артикул), на що звернути увагу при виборі.
- seo_title — заголовок сторінки для пошуковика, 35–60 знаків: що це + бренд + модель чи артикул + головна характеристика. Без назви магазину.
- seo_description — опис для пошуковика, 110–155 знаків: що це, для чого, і спокійне завершення на кшталт «Замовляйте з доставкою по Україні». Без лапок і великих літер підряд.

- seo_keywords — 4–8 коротких фраз через кому, якими шукають саме цей товар: вид товару, бренд, модель чи артикул, головна характеристика («моторна олива 5W-40, Castrol Magnatec, олива 4 л»). Лише з даних товару; без «купити», «ціна», назв міст.

ЗАЛІЗНЕ ПРАВИЛО: тільки факти з даних товару. Жодного числа, бренду, моделі авто, стандарту, матеріалу чи властивості, яких у даних немає. Не знаєш, на яке авто, — не пиши авто взагалі. Мало даних — пиши коротше й загальніше, але правдиво. Програма перевіряє кожне число й кожне латинське слово за даними товару; текст із вигадкою на сайт не піде.
ДАНІ БУВАЮТЬ НЕОХАЙНІ. Головне джерело — назва товару. Категорія може бути помилковою: якщо вона суперечить назві («Рульова колонка» в категорії «Кульова опора») — вір назві, категорію не згадуй. Службові коди з прайсів у назві («5 13348 40», «VL», «>>>») у текст не переноси. Назва російською — пиши українською, бренд, модель і артикул не перекладай. Якщо з назви не зрозуміло, що це за товар, — поверни для нього порожні рядки: програма відкладе його людині.
НЕ ПИШИ: ціну, знижки, наявність, гарантію, сертифікати, країну виробництва, «оригінал», «найкращий», «найдешевший», строки служби, закупівлю, постачальника.
СТИЛЬ: спокійно і по-людськи, без вигуків, без «унікальний», «ідеальний», «незамінний», без повтору назви в кожному реченні. Кожен текст свій: не один шаблон на всі товари з підставленою назвою. Слова, якими шукають (олива/масло, колодки гальмівні), — природно, один раз.
Номери-аналоги (якщо дано) можна згадати одним реченням «Замінює номери: …» — лише ті, що в даних.${styleNote ? `\n\nПОБАЖАННЯ ВЛАСНИКА ДО СТИЛЮ (виконуй, якщо не суперечить правилам вище): ${styleNote}` : ''}

Відповідь — ЛИШЕ JSON без пояснень: {"items":[{"n":<номер товару>,"description":"…","seo_title":"…","seo_description":"…","seo_keywords":"…"}]}`
}

export function productLine(n: number, facts: ProductFacts): string {
  const specs = flat(facts.specs).replace(/\s+/g, ' ').trim().slice(0, 600)
  return [`№${n}`, `назва: ${facts.name.replace(/\s+/g, ' ').trim()}`, facts.sku ? `артикул: ${facts.sku}` : '', facts.brand ? `бренд: ${facts.brand}` : '',
    facts.category ? `категорія: ${facts.category}` : '', facts.unit ? `одиниця: ${facts.unit}` : '', facts.oem ? `номер виробника: ${facts.oem}` : '',
    specs ? `характеристики: ${specs}` : '', facts.crosses?.length ? `номери-аналоги: ${facts.crosses.slice(0, 12).join(', ')}` : ''].filter(Boolean).join(' | ')
}
