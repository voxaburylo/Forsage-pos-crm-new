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

export interface ProductTextInput { product_id?: unknown; description?: unknown; seo_title?: unknown; seo_description?: unknown }
export interface ProductText { product_id: string; description?: string; seo_title?: string; seo_description?: string; notes: string[] }
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
    if (!description && !title && !meta) { refused.push({ product_id: id, reason: 'порожня пропозиція' }); continue }
    const all = [description, title, meta].join(' ')
    if (MONEY.test(all)) { refused.push({ product_id: id, reason: 'у тексті є ціна — вона застаріє, сайт показує ціну сам' }); continue }
    if (SECRET.test(all)) { refused.push({ product_id: id, reason: 'у тексті згадано закупівлю чи націнку' }); continue }
    const notes: string[] = []
    if (title.length > SEO_LIMITS.title) notes.push(`заголовок ${title.length} знаків — Google обріже після ~${SEO_LIMITS.title}`)
    if (meta.length > SEO_LIMITS.description) notes.push(`опис для пошуковика ${meta.length} знаків — Google обріже після ~${SEO_LIMITS.description}`)
    if (description && description.length < 120) notes.push('опис короткий')
    ok.push({ product_id: id, ...(description ? { description } : {}), ...(title ? { seo_title: title } : {}), ...(meta ? { seo_description: meta } : {}), notes })
  }
  return { ok, refused }
}
