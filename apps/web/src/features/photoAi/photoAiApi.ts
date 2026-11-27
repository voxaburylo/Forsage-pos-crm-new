import { api } from '@/lib/api'

/**
 * «Пошук фото з ШІ» (27.11.2026, слово власника: функцію перенесено із сайту в програму).
 * Шукає, перевіряє, стискає й зберігає фото сервер; у картку товару адресу фото ставить головний ПК (каса — головна база),
 * і далі воно їде на сайт звичайним обміном. Тут — запити до сервера й чисті правила екрана.
 */
const BASE = '/api/v1/ai/photo-ai'

export interface PhotoAiSettings { photos_per_product: number; require_white: boolean; forbid_text: boolean; min_size: number; night_only: boolean }
export interface PhotoAiKeys { serper: boolean; serper_hint: string; gemini: boolean; gemini_hint: string }
export interface PhotoAiUsage { serper_today: number; gemini_today: number; serper_month: number; gemini_month: number }
export interface PhotoAiJob {
  id: string; mode: 'review' | 'auto'; status: 'running' | 'stopped' | 'done'; stop_reason: string | null; stop_text: string | null
  total: number; done: number; found: number; serper_calls: number; gemini_calls: number; waiting_until: string | null; created_at: string; finished_at: string | null
}
export interface PhotoAiStatus {
  keys: PhotoAiKeys; settings: PhotoAiSettings; usage: PhotoAiUsage; job: PhotoAiJob | null
  review: number; unapplied: number; applied: number; compressor?: boolean; can_edit_keys: boolean
}
export interface PhotoAiProduct { id: string; name: string; sku?: string | null; brand?: string | null }
export interface CheckedPhoto { image_url: string; thumb_url: string; title: string; domain: string; page_url: string; width: number; height: number; score: number; ok: boolean; reason: string }
export interface ReviewProduct { product_id: string; name: string; photos: Array<{ id: string; url: string; thumb_url: string; source_page: string | null }> }

const quiet = { silent: true, timeoutMs: 20_000 }
export const photoAiApi = {
  status: (check = false) => api.get<{ data: PhotoAiStatus }>(BASE + '/status' + (check ? '?check=1' : ''), quiet).then(answer => answer.data),
  saveSettings: (settings: PhotoAiSettings) => api.post<{ data: PhotoAiSettings }>(BASE + '/settings', settings, undefined, quiet).then(answer => answer.data),
  saveKeys: (keys: { serper_key?: string; gemini_key?: string }) => api.post<{ data: PhotoAiKeys }>(BASE + '/keys', keys, undefined, quiet).then(answer => answer.data),
  search: (product: PhotoAiProduct) => api.post<{ data: { photos: CheckedPhoto[]; calls: { serper: number; gemini: number }; per_product: number } }>(
    BASE + '/search', { product }, undefined, { silent: true, timeoutMs: 70_000 }).then(answer => answer.data),
  save: (product: PhotoAiProduct, urls: string[]) => api.post<{ data: { main_url: string; saved: number; asked: number } }>(
    BASE + '/save', { product, urls }, undefined, { silent: true, timeoutMs: 90_000 }).then(answer => answer.data),
  eligible: (ids: string[]) => api.post<{ data: { ids: string[] } }>(BASE + '/eligible', { ids }, undefined, quiet).then(answer => answer.data.ids),
  start: (mode: 'review' | 'auto', products: PhotoAiProduct[]) => api.post<{ data: { job: PhotoAiJob; skipped: number } }>(BASE + '/jobs', { mode, products }, undefined, quiet).then(answer => answer.data),
  change: (id: string, action: 'stop' | 'resume') => api.post<{ data: PhotoAiJob }>(`${BASE}/jobs/${id}/${action}`, {}, undefined, quiet).then(answer => answer.data),
  review: () => api.get<{ data: { products: ReviewProduct[]; waiting: number } }>(BASE + '/review', quiet).then(answer => answer.data),
  decide: (productId: string, approve: string[]) => api.post<{ data: { approved: number; rejected: number } }>(BASE + '/decide', { product_id: productId, approve }, undefined, quiet).then(answer => answer.data),
  unapplied: () => api.get<{ data: Array<{ product_id: string; url: string }> }>(BASE + '/unapplied', quiet).then(answer => answer.data),
  applied: (applied: string[], skipped: string[]) => api.post<{ data: { applied: number; skipped: number } }>(BASE + '/applied', { applied, skipped }, undefined, quiet).then(answer => answer.data),
}

export const BATCH_SIZES = [10, 20, 50] as const
export const DEFAULT_BATCH = 20
/** Найбільше платних запитів на партію: 1 пошук і до 6 перевірок ШІ на товар. */
export const worstCaseCalls = (products: number) => ({ serper: products, gemini: products * 6 })

/** Вибір у картці: відмічені за порядком кліків, перше — головне; не більше дозволеного на товар. */
export function togglePick(picked: string[], url: string, max: number): string[] {
  if (picked.includes(url)) return picked.filter(item => item !== url)
  return picked.length >= max ? picked : [...picked, url]
}
/** Що відмічено одразу: підхожі на думку ШІ, найкращі першими. */
export const initialPicks = (photos: CheckedPhoto[], max: number) => photos.filter(photo => photo.ok).slice(0, max).map(photo => photo.image_url)

export function jobText(job: PhotoAiJob | null): string {
  if (!job) return 'Партій ще не було.'
  const progress = `готово ${job.done} з ${job.total}, з фото — ${job.found}`
  if (job.status === 'running') return job.waiting_until ? `Сервіс ШІ зайнятий — продовжу сам за кілька хвилин (${progress}).` : `Шукаю: ${progress}. Екран можна закрити.`
  if (job.status === 'done') return `Партію закінчено: ${progress}.`
  return (job.stop_text ?? 'Зупинено.') + ` (${progress})`
}

export interface CollectDeps {
  /** Сторінка товарів каси (саме каси: лише вона знає, у яких карток уже є своє фото). */
  listPage: (page: number) => Promise<{ data: Array<{ id: string; name: string; sku?: string | null; photo_url?: string | null; is_service?: boolean | number | null; brand?: { name?: string | null } | null }>; total_pages: number }>
  eligible: (ids: string[]) => Promise<string[]>
}
export const COLLECT_MAX_PAGES = 100
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Збирає партію: товари каси без фото (спершу ті, що є на складі), яких не шукали останні 30 днів.
 * Картку з фото не чіпаємо взагалі — ручні фото автоматичними не замінюються.
 */
export async function collectBatch(want: number, deps: CollectDeps, maxPages = COLLECT_MAX_PAGES): Promise<PhotoAiProduct[]> {
  const batch: PhotoAiProduct[] = []
  for (let page = 1; page <= maxPages && batch.length < want; page++) {
    const { data, total_pages } = await deps.listPage(page)
    const bare = data.filter(product => !product.photo_url && !product.is_service && UUID.test(product.id) && product.name?.trim())
    if (bare.length) {
      const allowed = new Set(await deps.eligible(bare.map(product => product.id)))
      for (const product of bare) {
        if (batch.length >= want) break
        if (allowed.has(product.id)) batch.push({ id: product.id, name: product.name.trim().slice(0, 500), sku: product.sku ?? null, brand: product.brand?.name ?? null })
      }
    }
    if (page >= total_pages) break
  }
  return batch
}

export interface ApplyDeps {
  list: () => Promise<Array<{ product_id: string; url: string }>>
  findCard: (id: string) => Promise<{ id: string; photo_url?: string | null } | null>
  setCardPhoto: (id: string, url: string) => Promise<unknown>
  report: (applied: string[], skipped: string[]) => Promise<unknown>
}
export const isOurAiPhoto = (url: unknown): url is string => typeof url === 'string' && /^https:\/\/[^\s]+\/product-photos\/ai\/[^\s]+\.webp$/.test(url) && url.length <= 600

/**
 * Ставить готові фото в картки (лише на ПК з базою каси). Картку, де вже є інше фото, не чіпає й повідомляє серверу
 * «пропущено». Збій по одній картці інших не зупиняє — наступного разу спробує знову.
 */
export async function applyApprovedPhotos(deps: ApplyDeps): Promise<{ applied: number; skipped: number; failed: number }> {
  const applied: string[] = [], skipped: string[] = []
  let failed = 0
  for (const photo of await deps.list()) {
    if (!UUID.test(photo.product_id) || !isOurAiPhoto(photo.url)) { failed += 1; continue }
    try {
      const card = await deps.findCard(photo.product_id)
      if (!card) skipped.push(photo.product_id)
      else if (card.photo_url === photo.url) applied.push(photo.product_id)
      else if (card.photo_url) skipped.push(photo.product_id)
      else { await deps.setCardPhoto(photo.product_id, photo.url); applied.push(photo.product_id) }
    } catch { failed += 1 }
  }
  if (applied.length || skipped.length) await deps.report(applied, skipped)
  return { applied: applied.length, skipped: skipped.length, failed }
}
