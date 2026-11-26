import { SEO_LIMITS, SITE_ORIGIN } from './siteSeoPrompt.js'

/** Чисті перетворення для SEO-помічника: читання сторінки сайту «очима Google» і перевірка текстів пропозиції. */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–' }
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : whole
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}
const clean = (value: string) => decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

/** Шлях лише на нашому сайті: без іншого хоста, без «..», без службових розділів. */
export function sitePath(raw: unknown): string {
  const path = String(raw ?? '').trim()
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('..') || path.length > 300 || /[\s<>"]/.test(path))
    throw new Error('Вкажіть шлях на нашому сайті, що починається з «/», напр. «/forum».')
  if (/^\/(admin|account|api)(\/|$|\?)/i.test(path)) throw new Error('Службові сторінки сайту помічник не читає.')
  const url = new URL(path, SITE_ORIGIN)
  if (url.origin !== SITE_ORIGIN) throw new Error('Помічник читає лише сторінки нашого сайту.')
  return url.pathname + url.search
}

export interface PageDigest { title: string; description: string; h1: string[]; headings: string[]; text: string; links: string[]; words: number }
/** Сторінка «очима Google»: заголовок, опис, заголовки, видимий текст і внутрішні посилання. */
export function pageDigest(html: string, textLimit = 6000): PageDigest {
  const source = html.slice(0, 1_500_000)
  const tag = (name: string) => [...source.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'gi'))].map(match => clean(match[1])).filter(Boolean)
  const meta = source.match(/<meta\s+[^>]*name=["']description["'][^>]*>/i)?.[0] ?? ''
  const body = source.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<head\b[\s\S]*?<\/head>/i, ' ')
  const text = clean(body)
  const links = [...new Set([...source.matchAll(/<a\s+[^>]*href=["'](\/[^"'#]*)["']/gi)].map(match => decodeEntities(match[1])))].slice(0, 150)
  // sitemap.xml: посилань <a> немає — беремо <loc>.
  const locs = links.length ? [] : [...new Set([...source.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(match => decodeEntities(match[1]).replace(SITE_ORIGIN, '')))].slice(0, 300)
  return {
    title: tag('title')[0] ?? '', description: clean(meta.match(/content=["']([^"']*)["']/i)?.[1] ?? ''),
    h1: tag('h1').slice(0, 5), headings: [...tag('h2'), ...tag('h3')].slice(0, 40),
    text: text.slice(0, textLimit), links: links.length ? links : locs, words: text ? text.split(' ').length : 0,
  }
}

export interface ProductTextInput { product_id?: unknown; description?: unknown; seo_title?: unknown; seo_description?: unknown; seo_keywords?: unknown }
export interface ProductText { product_id: string; description?: string; seo_title?: string; seo_description?: string; seo_keywords?: string; notes: string[] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const field = (value: unknown) => typeof value === 'string' ? value.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : ''
/** Ціна в тексті застаріє завтра; закупівлю й постачальника сайту не показуємо ніколи. */
const MONEY = /\d[\d\s.,]*\s?(грн|uah|₴)(?![\p{L}])/iu
const SECRET = /закупівельн|закупочн|закупк|собівартіст|себестоимост|націнк|наценк/iu

/**
 * Перевірка текстів пропозиції: порожні поля відкидаються, задовгі заголовки позначаються (власник бачить позначку й може
 * підтвердити), тексти з ціною чи закупівлею не пропускаються взагалі.
 */
export function checkProductTexts(items: readonly ProductTextInput[], known: ReadonlySet<string>): { ok: ProductText[]; refused: Array<{ product_id: string; reason: string }> } {
  const ok: ProductText[] = [], refused: Array<{ product_id: string; reason: string }> = [], seen = new Set<string>()
  for (const item of items.slice(0, SEO_LIMITS.products)) {
    const id = String(item?.product_id ?? '')
    if (!UUID.test(id) || !known.has(id)) { refused.push({ product_id: id, reason: 'товару з таким id немає' }); continue }
    if (seen.has(id)) continue
    seen.add(id)
    const description = field(item.description).slice(0, SEO_LIMITS.body), title = field(item.seo_title).replace(/\n/g, ' ').slice(0, 200), meta = field(item.seo_description).replace(/\n/g, ' ').slice(0, 400)
    const keywords = cleanKeywords(item.seo_keywords)
    if (!description && !title && !meta && !keywords) { refused.push({ product_id: id, reason: 'порожня пропозиція' }); continue }
    const all = [description, title, meta, keywords].join(' ')
    if (MONEY.test(all)) { refused.push({ product_id: id, reason: 'у тексті є ціна — вона застаріє, сайт показує ціну сам' }); continue }
    if (SECRET.test(all)) { refused.push({ product_id: id, reason: 'у тексті згадано закупівлю чи націнку' }); continue }
    const notes: string[] = []
    if (title.length > SEO_LIMITS.title) notes.push(`заголовок ${title.length} знаків — Google обріже після ~${SEO_LIMITS.title}`)
    if (meta.length > SEO_LIMITS.description) notes.push(`опис для пошуковика ${meta.length} знаків — Google обріже після ~${SEO_LIMITS.description}`)
    if (description && description.length < 120) notes.push('опис короткий')
    ok.push({ product_id: id, ...(description ? { description } : {}), ...(title ? { seo_title: title } : {}), ...(meta ? { seo_description: meta } : {}), ...(keywords ? { seo_keywords: keywords } : {}), notes })
  }
  return { ok, refused }
}

/** Ключові слова: фрази через кому, без повторів і порожніх, до 8 штук і 250 знаків. */
export function cleanKeywords(value: unknown): string {
  const seen = new Set<string>(), out: string[] = []
  const source = typeof value === 'string' ? value : Array.isArray(value) ? value.join(',') : ''
  for (const raw of source.split(/[,;\n]+/)) {
    const phrase = raw.replace(/\s+/g, ' ').trim(), key = phrase.toLocaleLowerCase('uk-UA')
    if (phrase.length < 2 || phrase.length > 60 || seen.has(key)) continue
    seen.add(key); out.push(phrase)
    if (out.length === 8) break
  }
  return out.join(', ').slice(0, 250)
}

/**
 * Форум: магазин пише як фахівець. Вигадані відгуки, «історії покупців» і діалоги від імені клієнтів заборонені
 * контрактом сайту («Не вигадуйте відгуків і діалогів від імені покупців») — такий текст не пропонуємо взагалі.
 */
const FAKE_VOICE: Array<[RegExp, string]> = [
  [/(?:^|\n)\s*[—–-]\s*\p{Lu}[^\n]{3,120}\n\s*[—–-]\s*\p{Lu}/u, 'У тексті є діалог.'],
  [/(наш|один)\s+(клієнт|покупець)\s+(розповів|написав|сказав|поділився|залишив)|відгук\s+(клієнта|покупця)|клієнт\s+\p{Lu}\p{L}+\s+(з|із)\s/iu, 'У тексті є вигаданий відгук чи історія покупця.'],
  [/(?:^|\n)\s*(покупець|клієнт|водій|\p{Lu}\p{L}+)\s*:\s*[«"„]/iu, 'У тексті є репліка від імені покупця.'],
]
export function forumPostProblem(text: string): string {
  if (MONEY.test(text)) return 'У тексті є ціна — вона застаріє.'
  if (SECRET.test(text)) return 'У тексті згадано закупівлю чи націнку.'
  return FAKE_VOICE.find(([pattern]) => pattern.test(text))?.[1] ?? ''
}

export interface SectionSeoInput { id?: unknown; seo_title?: unknown; seo_description?: unknown; description?: unknown; faq?: unknown }
export interface SectionSeo { id: string; name: string; seo_title?: string; seo_description?: string; description?: string; faq?: Array<{ q: string; a: string }>; notes: string[] }
/** Тексти розділів каталогу: без цін і закупівлі; питань-відповідей 3–5 (до 20 за контрактом, але більше пʼяти — вода). */
export function checkSectionSeo(items: readonly SectionSeoInput[], known: ReadonlyMap<string, string>): { ok: SectionSeo[]; refused: Array<{ id: string; reason: string }> } {
  const ok: SectionSeo[] = [], refused: Array<{ id: string; reason: string }> = [], seen = new Set<string>()
  for (const item of items.slice(0, 20)) {
    const id = String(item?.id ?? '')
    if (!known.has(id)) { refused.push({ id, reason: 'розділу з таким id немає' }); continue }
    if (seen.has(id)) continue
    seen.add(id)
    const title = field(item.seo_title).replace(/\n/g, ' ').slice(0, 200), meta = field(item.seo_description).replace(/\n/g, ' ').slice(0, 400), description = field(item.description).slice(0, 6000)
    const faq = (Array.isArray(item.faq) ? item.faq : []).map((row: any) => ({ q: field(row?.q).replace(/\n/g, ' ').slice(0, 200), a: field(row?.a).slice(0, 600) })).filter(row => row.q.length >= 8 && row.a.length >= 15).slice(0, 5)
    if (!title && !meta && !description && !faq.length) { refused.push({ id, reason: 'порожня пропозиція' }); continue }
    const all = [title, meta, description, ...faq.flatMap(row => [row.q, row.a])].join(' ')
    if (MONEY.test(all)) { refused.push({ id, reason: 'у тексті є ціна — вона застаріє' }); continue }
    if (SECRET.test(all)) { refused.push({ id, reason: 'у тексті згадано закупівлю чи націнку' }); continue }
    const notes: string[] = []
    if (title.length > SEO_LIMITS.title + 5) notes.push(`заголовок ${title.length} знаків — Google обріже`)
    if (meta && (meta.length < 120 || meta.length > 165)) notes.push(`опис для пошуковика ${meta.length} знаків (добре 140–160)`)
    if (Array.isArray(item.faq) && item.faq.length && faq.length < 3) notes.push('питань-відповідей менше трьох')
    ok.push({ id, name: known.get(id)!, ...(title ? { seo_title: title } : {}), ...(meta ? { seo_description: meta } : {}), ...(description ? { description } : {}), ...(faq.length ? { faq } : {}), notes })
  }
  return { ok, refused }
}
