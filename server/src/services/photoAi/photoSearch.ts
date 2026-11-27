/**
 * «Пошук фото з ШІ» (27.11.2026, слово власника: функцію перенесено із сайту в програму).
 * Крок 1 — пошук картинок Google через Serper.dev і відбір кандидатів. Тут лише запит, відсів і оцінка;
 * чи на фото саме цей товар, вирішує перевірка ШІ (photoVerdict.ts).
 */
export interface PhotoProduct { id: string; name: string; sku?: string | null; brand?: string | null }
export interface PhotoCandidate { imageUrl: string; title: string; link: string; domain: string; width: number; height: number; thumbnailUrl: string }
export interface ScoredCandidate extends PhotoCandidate { score: number }

export const SERPER_URL = 'https://google.serper.dev/images'
export const SERPER_RESULTS = 20
export const MAX_PIXELS = 9_000_000
export const MIN_RATIO = 0.7, MAX_RATIO = 1.45
/** Скільки найкращих кандидатів показуємо ШІ: у картці — 8 (стільки бачить людина), у масовому режимі — 6. */
export const CARD_TOP = 8, BULK_TOP = 6

/** Сайти, з яких фото не беремо: соцмережі, барахолки, фотобанки (і їхні сховища картинок). */
export const BLOCKED_SITES = ['pinterest', 'pinimg', 'aliexpress', 'alicdn', 'olx', 'facebook', 'fbcdn', 'fbsbx', 'instagram', 'cdninstagram', 'youtube', 'ytimg',
  'tiktok', 'tiktokcdn', 'vk', 'userapi', 'ok.ru', 'shutterstock', 'depositphotos', 'istockphoto', 'dreamstime', '123rf', 'freepik']

/** Причини, з яких чергу треба зупинити (потрібна дія власника), і «спробувати пізніше» (сервіс зайнятий). */
export type PhotoStopReason = 'serper_credits' | 'serper_key' | 'gemini_key' | 'gemini_model' | 'gemini_busy'
export class PhotoAiStop extends Error { constructor(public readonly reason: PhotoStopReason, message: string) { super(message) } }
export class PhotoAiLater extends Error { constructor(message: string) { super(message) } }

export const STOP_TEXT: Record<PhotoStopReason, string> = {
  serper_credits: 'На рахунку Serper.dev закінчились кредити. Поповніть рахунок на serper.dev і натисніть «Продовжити».',
  serper_key: 'Serper.dev не прийняв ключ. Перевірте ключ у налаштуваннях «Фото ШІ».',
  gemini_key: 'Gemini не прийняв ключ. Перевірте ключ у налаштуваннях «Фото ШІ».',
  gemini_model: 'Модель Gemini недоступна для цього ключа. Напишіть розробнику програми.',
  gemini_busy: 'Gemini довго відповідає «забагато запитів» — схоже, вичерпано денний ліміт ключа. Спробуйте «Продовжити» пізніше.',
}

/** Запит: бренд + назва; дужки з самими цифрами «(57235)» прибираємо, «/» — пробіл. */
export function buildQuery(name: string, brand?: string | null): string {
  let text = String(name ?? '').replace(/\(\s*\d+\s*\)/g, ' ').replace(/\//g, ' ').replace(/\s+/g, ' ').trim()
  const mark = String(brand ?? '').trim()
  if (mark && !text.toLowerCase().includes(mark.toLowerCase())) text = mark + ' ' + text
  return text.slice(0, 200)
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

export function isBlockedHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^www\./, '')
  if (!name) return false
  const labels = name.split('.')
  return BLOCKED_SITES.some(site => site.includes('.') ? name === site || name.endsWith('.' + site) : labels.includes(site))
}

/** Відповідь Serper: обʼєкт (один запит) або масив (пачка запитів). Кожен елемент — список картинок одного запиту. */
export function parseSerperImages(raw: unknown): PhotoCandidate[][] {
  const blocks = Array.isArray(raw) ? raw : [raw]
  return blocks.map(block => {
    const images = (block as { images?: unknown })?.images
    if (!Array.isArray(images)) return []
    const out: PhotoCandidate[] = []
    for (const item of images) {
      const row = (item ?? {}) as Record<string, unknown>
      const imageUrl = typeof row.imageUrl === 'string' ? row.imageUrl : ''
      if (!imageUrl) continue
      out.push({
        imageUrl, title: String(row.title ?? '').slice(0, 300), link: typeof row.link === 'string' ? row.link : '',
        domain: String(row.domain ?? '').toLowerCase() || hostOf(typeof row.link === 'string' ? row.link : ''),
        width: Number(row.imageWidth) || 0, height: Number(row.imageHeight) || 0,
        thumbnailUrl: typeof row.thumbnailUrl === 'string' ? row.thumbnailUrl : '',
      })
    }
    return out
  })
}

/** Чому картинку відкинуто ще до ШІ; null — годиться для оцінки. */
export function rejectReason(candidate: PhotoCandidate, minSize: number): string | null {
  if (!/^https:\/\//i.test(candidate.imageUrl) || candidate.imageUrl.length > 1500) return 'адреса'
  const { width, height } = candidate
  if (!width || !height) return 'розмір невідомий'
  if (Math.min(width, height) < minSize) return 'замала'
  if (width * height > MAX_PIXELS) return 'завелика'
  const ratio = width / height
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) return 'пропорції'
  if ([hostOf(candidate.imageUrl), hostOf(candidate.link), candidate.domain].some(isBlockedHost)) return 'сайт'
  return null
}

/** Для порівняння артикулів і брендів: лише літери й цифри, без регістру. */
export const squash = (value: string) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** Де шукаємо слова товару: заголовок картинки, адреса сторінки й адреса самої картинки. */
export function candidateText(candidate: PhotoCandidate): string {
  let text = candidate.title + ' ' + candidate.link + ' ' + candidate.imageUrl
  try { text = decodeURIComponent(text) } catch { /* адреса з «битими» відсотками — лишаємо як є */ }
  return text.toLowerCase()
}

/**
 * Оцінка: +3 за слово назви з цифрами, +1 за звичайне слово (від 3 літер), +6 за артикул (без пробілів і дефісів),
 * +2 за бренд, +1 якщо картинка від 800 px.
 */
export function scoreCandidate(candidate: PhotoCandidate, product: PhotoProduct): number {
  const text = candidateText(candidate), packed = squash(text)
  let score = 0
  const words = new Set(buildQuery(product.name).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))
  for (const word of words) {
    if (/\d/.test(word)) { if (word.length >= 2 && text.includes(word)) score += 3 }
    else if (word.length >= 3 && text.includes(word)) score += 1
  }
  const sku = squash(product.sku ?? '')
  if (sku.length >= 4 && packed.includes(sku)) score += 6
  const brand = squash(product.brand ?? '')
  if (brand.length >= 2 && packed.includes(brand)) score += 2
  if (Math.min(candidate.width, candidate.height) >= 800) score += 1
  return score
}

/** Відсів + оцінка + найкращі `top` (однакові адреси картинки — один раз). */
export function pickCandidates(images: PhotoCandidate[], product: PhotoProduct, minSize: number, top: number): ScoredCandidate[] {
  const seen = new Set<string>()
  const scored: ScoredCandidate[] = []
  for (const candidate of images) {
    if (seen.has(candidate.imageUrl) || rejectReason(candidate, minSize)) continue
    seen.add(candidate.imageUrl)
    scored.push({ ...candidate, score: scoreCandidate(candidate, product) })
  }
  return scored.sort((a, b) => b.score - a.score || b.width * b.height - a.width * a.height).slice(0, top)
}

export interface SerperDeps { fetch?: typeof fetch }

/** Один платний запит до Serper (можна пачкою кількох запитів). Повертає списки картинок у порядку запитів. */
export async function serperImages(apiKey: string, queries: string[], deps: SerperDeps = {}, signal?: AbortSignal): Promise<PhotoCandidate[][]> {
  const body = queries.map(q => ({ q, num: SERPER_RESULTS, gl: 'ua', hl: 'uk' }))
  let response: Response
  try {
    response = await (deps.fetch ?? fetch)(SERPER_URL, {
      method: 'POST', headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    })
  } catch { throw new PhotoAiLater('Serper.dev не відповів') }
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    if (/credit/i.test(text) || response.status === 402) throw new PhotoAiStop('serper_credits', STOP_TEXT.serper_credits)
    if (response.status === 401 || response.status === 403) throw new PhotoAiStop('serper_key', STOP_TEXT.serper_key)
    if (response.status === 429 || response.status >= 500) throw new PhotoAiLater('Serper.dev тимчасово недоступний (код ' + response.status + ')')
    throw new Error('Serper.dev відповів помилкою ' + response.status)
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('Serper.dev повернув незрозумілу відповідь') }
  const lists = parseSerperImages(parsed)
  return queries.map((_, index) => lists[index] ?? [])
}
