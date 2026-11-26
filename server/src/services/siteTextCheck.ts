import { productLine, type ProductFacts, type TextFields } from './siteTextGuard.js'

/**
 * Друга перевірка текстів товарів (26.11.2026, пара моделей): основна модель (Sonnet 5.5) написала текст, автоперевірка
 * за правилами (siteTextGuard) його пропустила — тепер помічниця (Haiku 5.5) читає текст поруч із даними товару й каже,
 * чи є в ньому те, чого в даних немає. Це задача «порівняй і класифікуй» — саме те, в чому швидка модель сильна.
 * Сумнівний текст на сайт не йде, а відкладається «на перевірку» з причиною.
 */
export function checkPrompt(): string {
  return `Ти — редактор-перевіряльник інтернет-магазину автозапчастин. Інший автор написав тексти для сторінок товарів. Для кожного товару тобі дано ДАНІ товару (усе, що магазин про нього знає) і ТЕКСТИ.

Постав «ok»: false лише якщо в текстах є хоча б одне з цього:
1. Факт про САМЕ ЦЕЙ товар, якого немає в даних: марка чи модель авто, рік, двигун, розмір, обʼєм, вага, матеріал, країна, кількість у комплекті, допуск чи стандарт, гарантія, строк служби.
2. Переплутано вид товару (у даних — фільтр, у тексті — колодки) або бренд чи артикул.
3. Обіцянки й оцінки: «найкращий», «оригінал», «гарантовано підходить», ціна, знижка, наявність, строк доставки.
4. Російські слова чи речення (назви брендів і моделей латиницею — це нормально).
5. Текст не про цей товар або беззмістовний.

НЕ вважай помилкою: загальне пояснення, що це за деталь і для чого вона (це знання, а не факт про товар); пораду звірити артикул чи розмір перед купівлею; фразу про доставку по Україні; переклад назви з російської на українську; інший порядок слів.
Коли сумніваєшся — став «ok»: true: зайва тривога теж шкодить.

Відповідь — ЛИШЕ JSON без пояснень: {"items":[{"n":<номер товару>,"ok":true}, {"n":<номер>,"ok":false,"why":"<коротко українською, що саме не так>"}]}`
}

export function checkLine(n: number, facts: ProductFacts, fields: TextFields): string {
  return [`ДАНІ: ${productLine(n, facts)}`, `ТЕКСТИ №${n}:`, `заголовок: ${fields.seo_title}`, `опис для пошуковика: ${fields.seo_description}`,
    fields.seo_keywords ? `ключові слова: ${fields.seo_keywords}` : '', `опис: ${fields.description}`].filter(Boolean).join('\n')
}

/** Відповідь перевіряльника → лише сумнівні товари з причиною. Незрозуміла відповідь нікого не блокує. */
export function parseCheckReply(text: string, known: ReadonlySet<number>): Map<number, string> {
  const out = new Map<number, string>()
  const from = text.indexOf('{'), to = text.lastIndexOf('}')
  if (from < 0 || to <= from) return out
  let parsed: unknown
  try { parsed = JSON.parse(text.slice(from, to + 1)) } catch { return out }
  const items = (parsed as { items?: unknown })?.items
  if (!Array.isArray(items)) return out
  for (const raw of items) {
    const row = (raw ?? {}) as { n?: unknown; ok?: unknown; why?: unknown }
    const n = Number(row.n)
    if (!known.has(n) || row.ok !== false) continue
    const why = String(row.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    out.set(n, why || 'текст викликав сумнів')
  }
  return out
}
