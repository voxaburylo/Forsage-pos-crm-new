import { buildQuery, candidateText, pickCandidates, serperImages, PhotoAiLater, PhotoAiStop, type PhotoCandidate, type PhotoProduct, type ScoredCandidate, type SerperDeps } from './photoSearch.js'
import { decidePhoto, geminiVerdict, verdictPrompt, type GeminiDeps, type PhotoVerdict } from './photoVerdict.js'
import { downloadImage, type Downloaded } from './photoStore.js'
import type { PhotoAiKeys, PhotoAiSettings, PhotoCalls } from './photoAiConfig.js'

/**
 * «Пошук фото з ШІ»: один товар від запиту до списку перевірених фото.
 * Пошук (1 платний запит Serper) → найкращі кандидати → кожного завантажити й показати Gemini (1 платний запит на фото).
 */
export interface CheckedPhoto {
  image_url: string; thumb_url: string; title: string; domain: string; page_url: string; width: number; height: number; score: number
  ok: boolean; reason: string; verdict: PhotoVerdict | null
  /** Байти вже завантаженої картинки — лише всередині сервера (щоб не качати вдруге); назовні не віддаються. */
  bytes?: Buffer
}
export interface FinderDeps extends SerperDeps, GeminiDeps {
  search?: (apiKey: string, query: string, signal?: AbortSignal) => Promise<PhotoCandidate[][]>
  download?: (url: string, signal?: AbortSignal) => Promise<Downloaded | null>
  verdict?: (apiKey: string, image: { mime: string; base64: string }, prompt: string, signal?: AbortSignal) => Promise<PhotoVerdict | null>
}

async function checkOne(candidate: ScoredCandidate, product: PhotoProduct, settings: PhotoAiSettings, geminiKey: string, calls: PhotoCalls, deps: FinderDeps, signal?: AbortSignal): Promise<CheckedPhoto> {
  const base = { image_url: candidate.imageUrl, thumb_url: candidate.thumbnailUrl, title: candidate.title, domain: candidate.domain, page_url: candidate.link,
    width: candidate.width, height: candidate.height, score: candidate.score }
  const image = await (deps.download ?? downloadImage)(candidate.imageUrl, signal)
  if (!image) return { ...base, ok: false, reason: 'фото не завантажилось або це не jpeg/png/webp від 3 КБ до 2,5 МБ', verdict: null }
  calls.gemini += 1
  const verdict = deps.verdict
    ? await deps.verdict(geminiKey, { mime: image.mime, base64: image.bytes.toString('base64') }, verdictPrompt(product), signal)
    : await geminiVerdict(geminiKey, { mime: image.mime, base64: image.bytes.toString('base64') }, verdictPrompt(product), deps, signal)
  if (!verdict) return { ...base, ok: false, reason: 'ШІ не зміг оцінити це фото', verdict: null }
  const decision = decidePhoto(verdict, settings, product, candidateText(candidate))
  return { ...base, ok: decision.ok, reason: decision.reason, verdict, ...(decision.ok ? { bytes: image.bytes } : {}) }
}

/**
 * top — скільки найкращих кандидатів показати ШІ; need — на скількох підхожих зупинитись (null — перевірити всіх:
 * у картці людина хоче бачити всі варіанти). Перевіряє пачками по три, щоб не платити за зайві фото.
 * Лічильник calls поповнюється навіть коли робота обривається помилкою — витрачене має бути видно.
 */
export async function findPhotos(product: PhotoProduct, settings: PhotoAiSettings, keys: PhotoAiKeys, calls: PhotoCalls,
  options: { top: number; need: number | null }, deps: FinderDeps = {}, signal?: AbortSignal): Promise<CheckedPhoto[]> {
  if (!keys.serper) throw new PhotoAiStop('serper_key', 'Немає ключа Serper.dev. Власник вставляє його в налаштуваннях «Фото ШІ».')
  if (!keys.gemini) throw new PhotoAiStop('gemini_key', 'Немає ключа Gemini. Власник вставляє його в налаштуваннях «Фото ШІ».')
  const query = buildQuery(product.name, product.brand)
  if (query.length < 3) return []
  calls.serper += 1
  const lists = deps.search ? await deps.search(keys.serper, query, signal) : await serperImages(keys.serper, [query], deps, signal)
  const candidates = pickCandidates(lists[0] ?? [], product, settings.min_size, options.top)
  const checked: CheckedPhoto[] = []
  const step = options.need === null ? 4 : 3
  for (let start = 0; start < candidates.length; start += step) {
    if (options.need !== null && checked.filter(photo => photo.ok).length >= options.need) break
    const results = await Promise.allSettled(candidates.slice(start, start + step).map(candidate => checkOne(candidate, product, settings, keys.gemini!, calls, deps, signal)))
    for (const result of results) {
      if (result.status === 'fulfilled') checked.push(result.value)
      else if (result.reason instanceof PhotoAiStop || result.reason instanceof PhotoAiLater) throw result.reason
    }
  }
  return checked
}
