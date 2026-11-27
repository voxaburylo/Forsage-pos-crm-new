import { createHash } from 'node:crypto'
import { imageMime, safeFetch } from '../safeFetch.js'
import { MAX_PIXELS } from './photoSearch.js'

/**
 * «Пошук фото з ШІ», крок 3 — завантаження, стиснення і зберігання у СВОЄМУ сховищі (чужі посилання вмирають).
 * Головне фото — до 1200 px по довгій стороні, WebP ~80; мала копія — 400 px, WebP ~75. Прозорий фон заливається білим.
 * Мала копія лежить поруч із головною: та сама адреса із закінченням «_400.webp».
 */
export const PHOTO_BUCKET = 'product-photos'
export const AI_FOLDER = 'ai'
export const IMAGE_MIN_BYTES = 3_000, IMAGE_MAX_BYTES = 2_500_000, DOWNLOAD_TIMEOUT_MS = 10_000
export const FULL_SIDE = 1200, THUMB_SIDE = 400
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface Downloaded { bytes: Buffer; mime: 'image/jpeg' | 'image/png' | 'image/webp' }
export interface StoreDeps {
  download?: (url: string, signal?: AbortSignal) => Promise<Downloaded | null>
  compress?: (bytes: Buffer) => Promise<Compressed>
  upload?: (path: string, bytes: Buffer) => Promise<string>
  remove?: (paths: string[]) => Promise<void>
}
export interface Compressed { full: Buffer; thumb: Buffer; width: number; height: number }

/** Картинка з інтернету: лише https, лише jpeg/png/webp (за вмістом, а не за назвою), від 3 КБ до 2,5 МБ, до 10 с. */
export async function downloadImage(url: string, signal?: AbortSignal): Promise<Downloaded | null> {
  try {
    const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    const got = await safeFetch(url, IMAGE_MAX_BYTES, signal ? AbortSignal.any([signal, timeout]) : timeout)
    const mime = imageMime(got.bytes)
    if (!mime || got.bytes.length < IMAGE_MIN_BYTES) return null
    return { bytes: got.bytes, mime }
  } catch { return null }
}

/** Стиснення. Бібліотека завантажується лише тут: якщо на сервері її немає, решта програми працює як завжди. */
export async function compressPhoto(bytes: Buffer): Promise<Compressed> {
  const sharp = (await import('sharp')).default
  const base = () => sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate().flatten({ background: '#ffffff' })
  const full = await base().resize({ width: FULL_SIDE, height: FULL_SIDE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true })
  const thumb = await base().resize({ width: THUMB_SIDE, height: THUMB_SIDE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer()
  return { full: full.data, thumb, width: full.info.width, height: full.info.height }
}

/** Чи працює стиснення на цьому сервері (видно в стані функції без жодного платного запиту). */
export async function compressorWorks(): Promise<boolean> {
  try {
    const sharp = (await import('sharp')).default
    const sample = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer()
    return (await compressPhoto(sample)).full.length > 0
  } catch { return false }
}

async function upload(path: string, bytes: Buffer): Promise<string> {
  const { supabaseAdmin } = await import('../../db/supabaseAdmin.js')
  const saved = await supabaseAdmin.storage.from(PHOTO_BUCKET).upload(path, bytes, { contentType: 'image/webp', upsert: true, cacheControl: '31536000' })
  if (saved.error) throw new Error('Сховище не прийняло фото: ' + saved.error.message)
  return supabaseAdmin.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl
}

export const thumbUrlOf = (url: string) => url.replace(/\.webp$/, '_400.webp')
/** Чи це фото з нашої теки «ai» (за адресою видно, що його знайшла функція, а не поставила людина). */
export const isAiPhotoUrl = (url: unknown) => typeof url === 'string' && url.includes('/' + PHOTO_BUCKET + '/' + AI_FOLDER + '/')

/** Стискає й кладе у сховище. Назва файла — від вмісту: те саме фото вдруге не займає місця. */
export async function storePhoto(tenantId: string, productId: string, bytes: Buffer, deps: StoreDeps = {}): Promise<{ url: string; thumb_url: string; width: number; height: number }> {
  if (!UUID.test(tenantId) || !UUID.test(productId)) throw new Error('Некоректний код товару')
  const packed = await (deps.compress ?? compressPhoto)(bytes)
  const name = createHash('sha256').update(packed.full).digest('hex').slice(0, 20)
  const folder = AI_FOLDER + '/' + tenantId + '/' + productId + '/'
  const url = await (deps.upload ?? upload)(folder + name + '.webp', packed.full)
  const thumb = await (deps.upload ?? upload)(folder + name + '_400.webp', packed.thumb)
  return { url, thumb_url: thumb, width: packed.width, height: packed.height }
}

/** Шлях у сховищі за відкритою адресою (лише наша тека «ai» цього магазину); інше — null. */
export function storedPath(url: string, tenantId: string): string | null {
  const marker = '/' + PHOTO_BUCKET + '/'
  const at = url.indexOf(marker)
  if (at < 0) return null
  let path: string
  try { path = decodeURIComponent(url.slice(at + marker.length).split('?')[0]) } catch { return null }
  if (!path.startsWith(AI_FOLDER + '/' + tenantId + '/') || path.split('/').some(part => part === '..' || part === '.' || part === '')) return null
  return path
}

/** Прибирає відхилені фото зі сховища (головне й малу копію). Збій прибирання роботу не зупиняє. */
export async function removeStored(tenantId: string, urls: string[], deps: StoreDeps = {}): Promise<void> {
  const paths = [...new Set(urls.flatMap(url => [storedPath(url, tenantId), storedPath(thumbUrlOf(url), tenantId)]).filter((path): path is string => Boolean(path)))]
  if (!paths.length) return
  try {
    if (deps.remove) { await deps.remove(paths); return }
    const { supabaseAdmin } = await import('../../db/supabaseAdmin.js')
    for (let start = 0; start < paths.length; start += 100) await supabaseAdmin.storage.from(PHOTO_BUCKET).remove(paths.slice(start, start + 100))
  } catch { /* файл лишиться у сховищі; на роботу це не впливає */ }
}
