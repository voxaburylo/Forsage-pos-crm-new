import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'

/**
 * Розділ «Сайт» ↔ сайт forsage-tires.com (24.11.2026, контракт розробника сайту).
 * Вікно програми ходить лише на СВІЙ сервер; ключ сайту додає сервер (server/src/services/siteGatewayService.ts).
 * Гроші в шлюзі — у гривнях (число), у програмі — в копійках.
 */
export const SITE_URL = 'https://www.forsage-tires.com'

export async function siteCall<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  return (await api.post<{ data: T }>('/api/v1/site-admin/gateway', { action, params }, undefined, { silent: true, timeoutMs: 25_000 })).data
}

export const errorText = (reason: unknown, fallback = 'Не вдалося виконати дію') => reason instanceof Error && reason.message ? reason.message : fallback

/** Список із шлюзу: дані, помилка, «завантажуємо» і перечитати. */
export function useSiteData<T>(action: string, params: Record<string, unknown> = {}) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const key = JSON.stringify(params)
  const turn = useRef(0)
  const reload = useCallback(async () => {
    const mine = ++turn.current
    setLoading(true)
    try {
      const answer = await siteCall<T>(action, JSON.parse(key) as Record<string, unknown>)
      if (mine === turn.current) { setData(answer); setError('') }
    } catch (reason) {
      if (mine === turn.current) setError(errorText(reason, 'Не вдалося отримати дані із сайту'))
    } finally { if (mine === turn.current) setLoading(false) }
  }, [action, key])
  useEffect(() => { void reload() }, [reload])
  return { data, error, loading, reload }
}

// ── Замовлення ──────────────────────────────────────────────────────────────────────────────────

export type SiteOrderStatus = 'new' | 'confirmed' | 'shipped' | 'completed' | 'canceled'
export const ORDER_STATUS_TEXT: Record<SiteOrderStatus, string> = { new: 'Нове', confirmed: 'Підтверджено', shipped: 'Відправлено', completed: 'Виконано', canceled: 'Скасовано' }
export const ORDER_STATUSES = Object.keys(ORDER_STATUS_TEXT) as SiteOrderStatus[]

export interface SiteOrderItem { product_id?: string | null; program_product_id?: string | null; title: string; qty: number; price: number }
export interface SiteOrder {
  id: string; created_at: string; status: SiteOrderStatus
  customer_name?: string | null; customer_phone?: string | null; customer_email?: string | null
  delivery_method?: string | null; city?: string | null; warehouse?: string | null; comment?: string | null
  total: number; tracking_number?: string | null; manager_comment?: string | null
  /** 27.11.2026: оплачено онлайн (LiqPay) — таке замовлення програма забирає сама (sitePaidOrders на сервері). */
  paid?: boolean; paid_at?: string | null; paid_amount?: number | null
  items: SiteOrderItem[]
}

export const uah = (value: unknown) => (Number(value) || 0).toLocaleString('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' грн'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

/**
 * Замовлення сайту → бланк замовлення програми (той самий, що приходить із телефона).
 * Товари програми (є program_product_id) стають позиціями — каса бере назву й закупку зі СВОЄЇ картки і не пустить
 * ціну нижче закупки. Позиції без картки (шини сайту) йдуть текстом у примітку. Грошей у бланку немає.
 */
export function siteOrderToProgramOrder(order: SiteOrder) {
  const items: Array<{ name: string; qty: number; sell_price: number; product_id: string }> = []
  const notes: string[] = []
  for (const item of order.items ?? []) {
    const qty = Number(item.qty), price = Math.round((Number(item.price) || 0) * 100)
    const title = String(item.title ?? '').trim() || 'Товар із сайту'
    if (isUuid(item.program_product_id) && qty > 0 && Math.round(qty * 1000) === qty * 1000) items.push({ name: title.slice(0, 300), qty, sell_price: price, product_id: item.program_product_id })
    else notes.push(`${title} — ${qty} шт × ${uah(item.price)}`)
  }
  const phone = String(order.customer_phone ?? '').replace(/\D/g, '')
  const delivery = [order.delivery_method, order.city, order.warehouse].map(part => String(part ?? '').trim()).filter(Boolean).join(', ')
  const comment = [
    'Замовлення із сайту № ' + order.id,
    delivery ? 'Доставка: ' + delivery : '',
    order.comment ? 'Клієнт: ' + String(order.comment).trim() : '',
    notes.length ? 'Не з каталогу програми (оформити окремо): ' + notes.join('; ') : '',
  ].filter(Boolean).join('. ').slice(0, 1000)
  return {
    payload: {
      customer_phone: phone.length >= 10 && phone.length <= 12 ? phone : null,
      customer_name: String(order.customer_name ?? '').trim().slice(0, 120) || null,
      // 27.11.2026: звичайне замовлення з джерелом «сайт» (стара збірка каси це поле просто не бачить).
      comment, author: 'Сайт', source: 'site' as const, items,
    },
    textOnly: notes,
  }
}

// ── Фото ────────────────────────────────────────────────────────────────────────────────────────

export interface SitePhoto { full: string; thumb: string }
export interface UploadSlot { full: { upload_url: string; public_url: string }; thumb: { upload_url: string; public_url: string } }
export const PHOTO_FULL = { side: 1000, quality: 0.8, bytes: 70 * 1024 }
export const PHOTO_THUMB = { side: 400, quality: 0.75, bytes: 20 * 1024 }

/** Розмір після зменшення: довша сторона не більша за side, пропорції збережено, менше зображення не розтягуємо. */
export function fitSide(width: number, height: number, side: number): { width: number; height: number } {
  const scale = Math.min(1, side / Math.max(width, height, 1))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Стискає зображення у WebP. Якщо файл більший за бажаний — знижує якість кроками, але не нижче 0,5. */
export async function compressWebp(file: Blob, target: { side: number; quality: number; bytes: number }, exact?: { width: number; height: number }): Promise<Blob> {
  const image = await createImageBitmap(file)
  try {
    const size = exact ?? fitSide(image.width, image.height, target.side)
    const canvas = document.createElement('canvas')
    canvas.width = size.width; canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Не вдалося обробити зображення')
    if (exact) {
      // Банер: заповнюємо рамку цілком, зайве обрізаємо по центру.
      const scale = Math.max(size.width / image.width, size.height / image.height)
      const width = image.width * scale, height = image.height * scale
      context.drawImage(image, (size.width - width) / 2, (size.height - height) / 2, width, height)
    } else context.drawImage(image, 0, 0, size.width, size.height)
    let blob: Blob | null = null
    for (let quality = target.quality; quality >= 0.5; quality -= 0.1) {
      blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality))
      if (!blob) break
      if (blob.size <= target.bytes) break
    }
    if (!blob || blob.type !== 'image/webp') throw new Error('Ця програма не вміє зберігати WebP — оновіть браузер')
    return blob
  } finally { image.close() }
}

/** Завантаження байтів за адресою, яку видав сайт. Лише https — інакше відмова. */
export async function putImage(uploadUrl: string, blob: Blob): Promise<void> {
  let url: URL
  try { url = new URL(uploadUrl) } catch { throw new Error('Сайт видав некоректну адресу для фото') }
  if (url.protocol !== 'https:') throw new Error('Сайт видав небезпечну адресу для фото')
  const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: blob })
  if (!response.ok) throw new Error('Сховище сайту не прийняло фото (код ' + response.status + ')')
}

/** Стискає й завантажує фото товару; повертає адреси для photos.attach, у тому ж порядку. */
export async function uploadProductPhotos(productId: string, files: Blob[], onStep?: (done: number) => void): Promise<SitePhoto[]> {
  if (!files.length) return []
  const slots = await siteCall<UploadSlot[]>('photos.upload_url', { program_product_id: productId, count: files.length })
  if (!Array.isArray(slots) || slots.length < files.length) throw new Error('Сайт видав менше адрес для фото, ніж потрібно')
  const uploaded: SitePhoto[] = []
  for (const [index, file] of files.entries()) {
    const [full, thumb] = [await compressWebp(file, PHOTO_FULL), await compressWebp(file, PHOTO_THUMB)]
    await putImage(slots[index].full.upload_url, full)
    await putImage(slots[index].thumb.upload_url, thumb)
    uploaded.push({ full: slots[index].full.public_url, thumb: slots[index].thumb.public_url })
    onStep?.(index + 1)
  }
  return uploaded
}

/**
 * Імʼя файла → артикул чи штрихкод: «WB-1065.jpg», «WB-1065_2.jpg», «WB-1065 (3).png» → «WB-1065».
 * Кілька фото одного товару відрізняються хвостом _2, -2 чи (2).
 */
export function photoFileKey(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{2,5}$/, '').trim()
  return base.replace(/\s*\(\d{1,2}\)$/, '').replace(/[_](\d{1,2})$/, '').trim()
}

export const IMAGE_FILE = /\.(jpe?g|png|webp|bmp|gif)$/i

/** Файли з папки → групи за артикулом/штрихкодом; порядок фото в групі — за іменем файла. */
export function groupPhotoFiles<T extends { name: string }>(files: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  // Номер фото з хвоста імені: «X.jpg» — перше (головне), «X_2.jpg» чи «X (2).jpg» — друге.
  const order = (name: string) => Number(/(?:_|\()(\d{1,2})\)?\.[A-Za-z0-9]{2,5}$/.exec(name)?.[1] ?? 1)
  for (const file of files.filter(item => IMAGE_FILE.test(item.name))) {
    const key = photoFileKey(file.name).toLowerCase()
    if (key) groups.set(key, [...(groups.get(key) ?? []), file])
  }
  const sorted = new Map<string, T[]>()
  for (const key of [...groups.keys()].sort((x, y) => x.localeCompare(y, 'uk', { numeric: true })))
    sorted.set(key, groups.get(key)!.sort((x, y) => order(x.name) - order(y.name) || x.name.localeCompare(y.name, 'uk', { numeric: true })))
  return sorted
}

/** Із знайдених карток — та, чий артикул чи штрихкод точно збігається з імʼям файла. Схожі не беремо. */
export function exactProductMatch<T extends { sku?: string | null; barcode?: string | null }>(key: string, found: T[]): T | null {
  const wanted = key.trim().toLowerCase()
  const exact = found.filter(product => String(product.sku ?? '').trim().toLowerCase() === wanted || String(product.barcode ?? '').trim().toLowerCase() === wanted)
  return exact.length === 1 ? exact[0] : null
}

// ── Дати для полів форми ────────────────────────────────────────────────────────────────────────

/** ISO → значення поля datetime-local (місцевий час); порожнє чи зіпсоване — ''. */
export function isoToLocalInput(iso: unknown): string {
  if (typeof iso !== 'string' || !iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
export function localInputToIso(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Лічильник нових замовлень сайту для червоного значка. Три невдачі поспіль — перестаємо питати до перезавантаження. */
export function useSiteUnseenCount(enabled: boolean, everyMs = 45_000): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!enabled) { setCount(0); return }
    let alive = true, failures = 0
    const ask = async () => {
      if (document.visibilityState !== 'visible' || failures >= 3) return
      try {
        const answer = await siteCall<{ count: number }>('orders.unseen_count')
        failures = 0
        if (alive) setCount(Math.max(0, Number(answer?.count) || 0))
      } catch { failures += 1 }
    }
    void ask()
    const timer = window.setInterval(() => void ask(), everyMs)
    return () => { alive = false; window.clearInterval(timer) }
  }, [enabled, everyMs])
  return count
}
