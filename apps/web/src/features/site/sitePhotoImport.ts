import { desktopBridge, isDesktopRuntime } from '@/lib/desktopBridge'

/**
 * «Імпорт фото з сайту» (24.11.2026, доповнення 3 розробника сайту).
 * Сайт сам знаходить фото товарів в інтернеті й перевіряє їх ШІ (той самий товар, білий фон, без написів).
 * Забирає їх ГОЛОВНИЙ ПК: каса — головна база, сервер у неї нічого не пише, тож фото, покладене просто в хмару,
 * до каси не дійшло б. Каса завантажує файл собі, ставить його в картку звичайним шляхом — і далі воно саме
 * їде в хмару разом з іншими змінами картки.
 * Своє фото програми завжди важливіше: картку, де фото вже є, не чіпаємо.
 * Авто-фото лежить у теці з міткою AUTO_PHOTO_FOLDER — за адресою файла видно, що воно з сайту.
 */
export const AUTO_PHOTO_FOLDER = 'auto-site'
export const SITE_PHOTO_SINCE_KEY = 'forsage:site-photos:since'
export const SITE_PHOTO_EVERY_MS = 60 * 60_000
export const SITE_PHOTO_MAX_BYTES = 3 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface SiteAutoPhoto { program_product_id: string; full: string; thumb?: string; found_at: string }
export interface SitePhotoImportResult { received: number; added: number; skippedHasPhoto: number; skippedNoCard: number; failed: number; since: string | null }

export const isAutoPhoto = (photoUrl: unknown) => typeof photoUrl === 'string' && photoUrl.replace(/\\/g, '/').includes('/photos/' + AUTO_PHOTO_FOLDER + '-')

/** Лише записи, яким можна довіряти за формою: код картки, https-адреса, дата. */
export function cleanAutoPhotos(raw: unknown): SiteAutoPhoto[] {
  if (!Array.isArray(raw)) return []
  const out: SiteAutoPhoto[] = []
  for (const item of raw) {
    const row = (item ?? {}) as Partial<SiteAutoPhoto>
    if (typeof row.program_product_id !== 'string' || !UUID.test(row.program_product_id)) continue
    if (typeof row.full !== 'string' || !/^https:\/\/[^\s]+$/.test(row.full) || row.full.length > 600) continue
    if (typeof row.found_at !== 'string' || Number.isNaN(Date.parse(row.found_at))) continue
    out.push({ program_product_id: row.program_product_id, full: row.full, found_at: row.found_at })
  }
  return out.sort((a, b) => Date.parse(a.found_at) - Date.parse(b.found_at))
}

export interface SitePhotoImportDeps {
  /** Список від сайту (через сервер програми). */
  list: (since: string | null) => Promise<unknown>
  findCard: (id: string) => Promise<{ id: string; photo_url?: string | null; is_active?: number | boolean } | null>
  download: (url: string) => Promise<ArrayBuffer>
  savePhoto: (folder: string, bytes: ArrayBuffer) => Promise<string>
  setCardPhoto: (id: string, photoUrl: string) => Promise<unknown>
  deletePhoto?: (photoUrl: string) => Promise<unknown>
  readSince: () => string | null
  writeSince: (value: string) => void
}

/**
 * Один прохід імпорту. Позначку «з якого часу» посуваємо лише до останнього запису, після якого не було збою:
 * фото, яке не вдалося завантажити, сайт віддасть ще раз наступного разу.
 */
export async function importSitePhotos(deps: SitePhotoImportDeps): Promise<SitePhotoImportResult> {
  const since = deps.readSince()
  const photos = cleanAutoPhotos(await deps.list(since))
  const result: SitePhotoImportResult = { received: photos.length, added: 0, skippedHasPhoto: 0, skippedNoCard: 0, failed: 0, since }
  let safeSince: string | null = null, broken = false
  for (const photo of photos) {
    try {
      const card = await deps.findCard(photo.program_product_id)
      if (!card) result.skippedNoCard += 1
      else if (card.photo_url) result.skippedHasPhoto += 1
      else {
        const bytes = await deps.download(photo.full)
        if (!bytes.byteLength || bytes.byteLength > SITE_PHOTO_MAX_BYTES) throw new Error('Неприпустимий розмір фото')
        const saved = await deps.savePhoto(AUTO_PHOTO_FOLDER + '-' + photo.program_product_id, bytes)
        try { await deps.setCardPhoto(photo.program_product_id, saved) }
        catch (error) { await deps.deletePhoto?.(saved).catch(() => undefined); throw error }
        result.added += 1
      }
      if (!broken) safeSince = photo.found_at
    } catch { result.failed += 1; broken = true }
  }
  if (safeSince && safeSince !== since) { deps.writeSince(safeSince); result.since = safeSince }
  return result
}

/** Чи може цей ПК забирати фото: лише головний ПК зі своїм ключем звʼязку. */
export function canImportSitePhotos(): boolean {
  const bridge = desktopBridge()
  return isDesktopRuntime() && Boolean(bridge?.link?.assistant && bridge.catalog?.savePhoto && bridge.catalog.findById)
}

/** Імпорт на головному ПК справжніми засобами програми. null — цей ПК не головний або звʼязок не налаштовано. */
export async function runSitePhotoImport(): Promise<SitePhotoImportResult | null> {
  const bridge = desktopBridge()
  const send = bridge?.link?.assistant, catalog = bridge?.catalog
  if (!canImportSitePhotos() || !send || !catalog?.savePhoto || !catalog.findById) return null
  const { productApi } = await import('@/features/products/productApi')
  return importSitePhotos({
    list: async since => {
      const answer = await send({ method: 'GET', path: '/site-photos' + (since ? '?since=' + encodeURIComponent(since) : '') })
      if (!answer) throw new Error('Звʼязок головного ПК не налаштовано')
      const parsed = JSON.parse(answer.text) as { data?: unknown; error?: { message?: string } }
      if (answer.status !== 200) throw new Error(parsed?.error?.message || 'Сервер не віддав список фото (код ' + answer.status + ')')
      return parsed.data
    },
    findCard: id => catalog.findById!(id),
    download: async url => {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
      if (!response.ok || !/^image\//.test(response.headers.get('content-type') ?? '')) throw new Error('Фото не завантажилось')
      return response.arrayBuffer()
    },
    savePhoto: (folder, bytes) => catalog.savePhoto!(folder, bytes),
    setCardPhoto: (id, photoUrl) => productApi.update(id, { photo_url: photoUrl } as never),
    deletePhoto: photoUrl => catalog.deletePhoto?.(photoUrl) ?? Promise.resolve(),
    readSince: () => { try { return localStorage.getItem(SITE_PHOTO_SINCE_KEY) } catch { return null } },
    writeSince: value => { try { localStorage.setItem(SITE_PHOTO_SINCE_KEY, value) } catch { /* наступний прохід повторить; картки з фото пропускаються */ } },
  })
}

export function sitePhotoImportText(result: SitePhotoImportResult): string {
  if (!result.received) return 'Нових фото від сайту немає.'
  return [`Отримано від сайту: ${result.received}`, `додано в картки: ${result.added}`,
    result.skippedHasPhoto ? `у картці вже є своє фото: ${result.skippedHasPhoto}` : '',
    result.skippedNoCard ? `картки немає: ${result.skippedNoCard}` : '',
    result.failed ? `не вдалося: ${result.failed} (спробуємо ще раз)` : ''].filter(Boolean).join(' · ')
}
