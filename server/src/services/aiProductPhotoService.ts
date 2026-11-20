import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { z } from 'zod'
import { ClaudeClient } from './aiClaude.js'
import { AppError } from '../middleware/errorHandler.js'
import { getAiConfig, recordAiUsage } from './aiService.js'
import { isAiBudgetError, withAiExecutionBudget } from './aiExecutionBudget.js'
import { rulesPromptSafe } from './aiMemoryService.js'

/**
 * Фото товарів з інтернету (рішення власника 20.11.2026: «фото — лише коли артикул і товар точно збігаються»).
 *
 * 1. Claude з веб-пошуком називає сторінку саме цього товару (магазин, виробник, постачальник).
 * 2. Сервер сам відкриває сторінку й перевіряє, що на ній є точний артикул; інакше фото не пропонується.
 * 3. Зі сторінки береться головне фото (og:image / JSON-LD Product.image) і перевіряється, що це справжня картинка.
 * Нічого не записується: фото показуються власнику, він вибирає, і програма зберігає їх звичайним шляхом.
 */
export const PHOTO_SEARCH_MAX_PRODUCTS = 8
const PAGE_MAX_BYTES = 3 * 1024 * 1024
const IMAGE_MAX_BYTES = 6 * 1024 * 1024
const FETCH_TIMEOUT_MS = 12_000
const MAX_REDIRECTS = 3

export const productPhotoRequestSchema = z.object({
  products: z.array(z.object({
    id: z.string().min(1).max(100),
    sku: z.string().max(200).optional().nullable(),
    name: z.string().min(1).max(500),
    brand: z.string().max(200).optional().nullable(),
  })).min(1).max(PHOTO_SEARCH_MAX_PRODUCTS),
})
export type ProductPhotoRequest = z.infer<typeof productPhotoRequestSchema>

export interface ProductPhotoResult {
  product_id: string
  status: 'found' | 'not_found'
  reason: string
  page_url?: string
  image_url?: string
  mime_type?: string
  image_base64?: string
}

/** Артикул для порівняння: без пробілів, дефісів, крапок і слешів, без регістру. */
export function normalizeArticle(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s\-._/\\]+/g, '')
}

export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  if (kind === 6) {
    const lower = address.toLowerCase()
    if (lower === '::' || lower === '::1') return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
    if (mapped) return isPrivateAddress(mapped[1])
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower)
  }
  return true
}

type Resolver = (host: string) => Promise<Array<{ address: string }>>
const defaultResolver: Resolver = host => lookup(host, { all: true })

/** Лише публічні https-адреси; кожне перенаправлення перевіряється заново (захист від звернень у внутрішню мережу). */
export async function safeFetch(rawUrl: string, maxBytes: number, signal: AbortSignal, resolver: Resolver = defaultResolver, fetchImpl: typeof fetch = fetch): Promise<{ url: string; contentType: string; bytes: Buffer }> {
  let url = new URL(rawUrl)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Дозволено лише звичайні https-адреси')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Внутрішня адреса')
    const addresses = isIP(host) ? [{ address: host }] : await resolver(host)
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error('Внутрішня адреса')
    const response = await fetchImpl(url, {
      redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ForsageCatalog/1.0)', Accept: 'text/html,image/*;q=0.9,*/*;q=0.5' },
    })
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location')
      if (!next) throw new Error('Перенаправлення без адреси')
      url = new URL(next, url)
      continue
    }
    if (!response.ok || !response.body) throw new Error('HTTP ' + response.status)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > maxBytes) throw new Error('Завеликий файл')
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length
      if (total > maxBytes) throw new Error('Завеликий файл')
      chunks.push(Buffer.from(chunk))
    }
    return { url: url.href, contentType: (response.headers.get('content-type') ?? '').toLowerCase(), bytes: Buffer.concat(chunks) }
  }
  throw new Error('Забагато перенаправлень')
}

function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
}

/** Видимий текст сторінки (без скриптів і стилів), а також вміст meta/alt, де магазини часто пишуть артикул. */
export function pageText(html: string): string {
  const attrs = [...html.matchAll(/\b(?:content|alt|title)\s*=\s*["']([^"']{1,500})["']/gi)].map(match => match[1]).join(' ')
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  return decodeEntities(body + ' ' + attrs)
}

/** Точний збіг артикулу: нормалізований артикул має бути окремим «словом» у нормалізованому тексті сторінки. */
export function pageHasArticle(html: string, sku: string): boolean {
  const wanted = normalizeArticle(sku)
  if (wanted.length < 4) return false
  const tokens = pageText(html).toLowerCase().split(/[^\p{L}\p{N}\-._/]+/u)
  for (let index = 0; index < tokens.length; index++) {
    // Артикул може бути розбитий пробілами на 2–3 частини («WA 6684»).
    for (let span = 1; span <= 3 && index + span <= tokens.length; span++) {
      if (normalizeArticle(tokens.slice(index, index + span).join('')) === wanted) return true
    }
  }
  return false
}

/** Головне фото товару зі сторінки: JSON-LD Product.image, потім og:image / twitter:image / image_src. */
export function extractProductImage(html: string, baseUrl: string): string | null {
  const candidates: string[] = []
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const visit = (node: any): void => {
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) { node.forEach(visit); return }
        const type = [].concat(node['@type'] ?? []).map(String)
        if (type.includes('Product')) {
          const image = node.image
          for (const item of [].concat(image ?? [])) candidates.push(typeof item === 'string' ? item : (item as any)?.url ?? (item as any)?.contentUrl ?? '')
        }
        if (node['@graph']) visit(node['@graph'])
      }
      visit(JSON.parse(match[1]))
    } catch { /* broken JSON-LD */ }
  }
  const meta = (name: string) => {
    const tag = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i').exec(html)?.[0]
    return tag ? /content=["']([^"']+)["']/i.exec(tag)?.[1] ?? '' : ''
  }
  candidates.push(meta('og:image'), meta('og:image:secure_url'), meta('twitter:image'))
  const link = /<link[^>]+rel=["']image_src["'][^>]*>/i.exec(html)?.[0]
  if (link) candidates.push(/href=["']([^"']+)["']/i.exec(link)?.[1] ?? '')
  for (const raw of candidates) {
    if (!raw) continue
    try {
      const url = new URL(decodeEntities(raw.trim()), baseUrl)
      if (url.protocol === 'https:' || url.protocol === 'http:') { url.protocol = 'https:'; return url.href }
    } catch { /* bad url */ }
  }
  return null
}

export function imageMime(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** Відповідь Claude: JSON-масив [{product_id, page_url}] десь у тексті. */
export function parseCandidatePages(text: string, ids: Set<string>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const block = /\[[\s\S]*\]/.exec(text)?.[0]
  if (!block) return out
  let rows: unknown
  try { rows = JSON.parse(block) } catch { return out }
  if (!Array.isArray(rows)) return out
  for (const row of rows) {
    const id = String((row as any)?.product_id ?? '')
    if (!ids.has(id)) continue
    const urls = [].concat((row as any)?.page_urls ?? (row as any)?.page_url ?? []).map(String).filter(value => /^https?:\/\//i.test(value)).slice(0, 3)
    if (urls.length) out.set(id, [...(out.get(id) ?? []), ...urls].slice(0, 3))
  }
  return out
}

export interface PhotoFetchDeps { fetchPage: (url: string, signal: AbortSignal) => Promise<{ url: string; contentType: string; bytes: Buffer }> }

/** Перевіряє кандидатів одного товару: сторінка з точним артикулом → головне фото → справжня картинка. */
export async function verifyCandidate(product: { id: string; sku?: string | null }, pages: string[], signal: AbortSignal, deps: PhotoFetchDeps): Promise<ProductPhotoResult> {
  const sku = product.sku?.trim() ?? ''
  if (normalizeArticle(sku).length < 4) return { product_id: product.id, status: 'not_found', reason: 'У товару немає артикулу (або він закороткий) — фото без точного збігу не підбираю.' }
  if (!pages.length) return { product_id: product.id, status: 'not_found', reason: 'ШІ не знайшов сторінки саме цього товару.' }
  let lastReason = 'На знайдених сторінках немає точного артикулу.'
  for (const pageUrl of pages) {
    try {
      const page = await deps.fetchPage(pageUrl, signal)
      if (!/html/.test(page.contentType)) { lastReason = 'Сторінка не відкрилась як HTML.'; continue }
      const html = page.bytes.toString('utf8')
      if (!pageHasArticle(html, sku)) { lastReason = `На сторінці немає артикулу ${sku}.`; continue }
      const imageUrl = extractProductImage(html, page.url)
      if (!imageUrl) { lastReason = 'На сторінці товару немає головного фото.'; continue }
      const image = await deps.fetchPage(imageUrl, signal)
      const mime = imageMime(image.bytes)
      if (!mime || image.bytes.length < 2_000) { lastReason = 'Фото на сторінці недоступне або це не картинка.'; continue }
      return { product_id: product.id, status: 'found', reason: `Артикул ${sku} є на сторінці.`, page_url: page.url, image_url: imageUrl, mime_type: mime, image_base64: image.bytes.toString('base64') }
    } catch (error) {
      if (isAiBudgetError(error) || signal.aborted) throw error
      lastReason = 'Сторінка не відкрилась: ' + (error instanceof Error ? error.message : String(error)).slice(0, 120)
    }
  }
  return { product_id: product.id, status: 'not_found', reason: lastReason }
}

export async function findProductPhotos(tenantId: string, userId: string | null, input: ProductPhotoRequest, deps: PhotoFetchDeps = {
  fetchPage: (url, signal) => safeFetch(url, /\.(jpe?g|png|webp)(\?|$)/i.test(url) ? IMAGE_MAX_BYTES : PAGE_MAX_BYTES, signal),
}): Promise<{ results: ProductPhotoResult[]; usage: { cost_usd_estimate: number } }> {
  return withAiExecutionBudget(240_000, async budget => {
    const cfg = await budget.run(signal => getAiConfig(tenantId, signal))
    if (!cfg.apiKey) throw new AppError('AI_NOT_CONFIGURED', 'Ключ Anthropic не налаштовано. Додайте його в Налаштування → ШІ.', 400)
    if (!cfg.enabled) throw new AppError('AI_DISABLED', 'Помічник ШІ вимкнено в Налаштуваннях.', 400)
    const rules = await budget.run(() => rulesPromptSafe(tenantId))
    const lines = input.products.map(product => `- product_id ${product.id}: ${product.name}; артикул ${product.sku || '—'}; бренд ${product.brand || '—'}`).join('\n')
    const prompt = `Знайди в інтернеті сторінки саме цих автотоварів, щоб узяти з них фото товару.
Потрібна сторінка, де надруковано ТОЧНО цей артикул (магазин автозапчастин, сайт виробника або постачальника). Схожі товари, аналоги й інші артикули не підходять.
Якщо в правилах власника вказано сайт постачальника з фото — шукай спершу там.
Для кожного товару дай до 3 адрес сторінок (найкращі першими). Якщо сторінки з точним артикулом немає — не вигадуй, пропусти товар.
Відповідь — лише JSON-масив: [{"product_id":"…","page_urls":["https://…"]}].
${lines}${rules}`
    const claude = new ClaudeClient(cfg.apiKey, cfg.model as any)
    const found = await claude.research(budget, prompt, Math.min(10, input.products.length * 2))
    await budget.run(signal => recordAiUsage(tenantId, userId, cfg.model, found.promptTokens, found.completionTokens, signal, found.costAdjustUsd ?? 0))
    const pages = parseCandidatePages(found.text, new Set(input.products.map(product => product.id)))
    const results: ProductPhotoResult[] = []
    for (const product of input.products) {
      results.push(await verifyCandidate(product, pages.get(product.id) ?? [], budget.signal, deps))
    }
    const cost = (found.promptTokens * 2 + found.completionTokens * 10) / 1_000_000 + (found.costAdjustUsd ?? 0)
    return { results, usage: { cost_usd_estimate: Math.max(0, Math.round(cost * 10000) / 10000) } }
  })
}
