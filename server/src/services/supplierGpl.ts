import { AppError } from '../middleware/errorHandler.js'
import { code, restQty, type OfferRow, type OmegaDeps } from './supplierApiService.js'

/**
 * Постачальник GPL (документація: https://back.online.gpl.ua/api/documentation, прочитано 25.11.2026).
 * Вхід — логін і пароль (POST /api/v2/auth/login → токен), далі GET /api/v2/prices сторінками: товар (cid, артикул,
 * номер деталі, бренд, назва, опис, категорія, фото), кілька цін (назва + ціна) і залишки по складах.
 * Кросів, застосовності й замовлень в API GPL немає — аналоги беремо з кросів Омеги за артикулом.
 */
export const GPL_BASE = 'https://back.online.gpl.ua'
// 26.11.2026: GPL відмовив «The per page field must not be greater than 100» (фото власника) — сторінка не більше 100.
export const GPL_PAGE_SIZE = 100

export interface GplCredentials { login: string; password: string }
export interface GplItem { cid?: unknown; category?: unknown; brand?: unknown; article?: unknown; partNumber?: unknown; name?: unknown; description?: unknown
  imagePath?: unknown; prices?: Array<{ id?: unknown; name?: unknown; price?: unknown }>; warehouses?: Array<{ id?: unknown; name?: unknown; quantity?: unknown }> }
export type GplOffer = OfferRow & { description: string | null; category_name: string | null }

/** Облікові дані GPL зберігаються в полі ключа як JSON. */
export function gplCredentials(stored: string): GplCredentials {
  try {
    const value = JSON.parse(stored) as Partial<GplCredentials>
    if (typeof value.login === 'string' && typeof value.password === 'string' && value.login && value.password) return { login: value.login, password: value.password }
  } catch { /* нижче — помилка */ }
  throw new AppError('SUPPLIER_CONFIG', 'Логін і пароль GPL не збережено — введіть їх у Сайт → Налаштування → «Ключі API»', 422)
}

async function gplFetch<T>(path: string, init: RequestInit, deps: OmegaDeps = {}, timeoutMs = 60_000): Promise<T> {
  let response: Response
  try {
    response = await (deps.fetchImpl ?? fetch)(GPL_BASE + path, { ...init, headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) })
  } catch { throw new AppError('SUPPLIER_UNAVAILABLE', 'GPL не відповідає', 502) }
  const json = await response.json().then(value => value as T & { success?: boolean; message?: string }, () => null)
  if (response.status === 401 || response.status === 403) throw new AppError('SUPPLIER_REFUSED', 'GPL не прийняв логін або пароль', 422)
  if (response.status === 429) throw new AppError('SUPPLIER_LIMIT', 'GPL просить зачекати (забагато запитів) — продовжимо пізніше', 429)
  if (!response.ok || !json || json.success === false) throw new AppError('SUPPLIER_REFUSED', 'GPL відмовив: ' + String(json?.message ?? 'HTTP ' + response.status).slice(0, 200), 502)
  return json
}

export async function gplLogin(credentials: GplCredentials, deps: OmegaDeps = {}): Promise<string> {
  const answer = await gplFetch<{ data?: { token?: unknown } }>('/api/v2/auth/login', { method: 'POST', body: JSON.stringify(credentials) }, deps, 20_000)
  const token = typeof answer.data?.token === 'string' ? answer.data.token : ''
  if (!token) throw new AppError('SUPPLIER_REFUSED', 'GPL не видав доступ', 422)
  return token
}

export async function gplPage(token: string, page: number, deps: OmegaDeps = {}): Promise<{ items: GplItem[]; total: number; lastPage: number }> {
  const query = new URLSearchParams({ page: String(page), perPage: String(GPL_PAGE_SIZE), priceDelimiter: '.' })
  const answer = await gplFetch<{ data?: unknown; meta?: { total?: unknown; lastPage?: unknown } }>('/api/v2/prices?' + query, { method: 'GET', headers: { Authorization: 'Bearer ' + token } }, deps)
  return { items: Array.isArray(answer.data) ? answer.data as GplItem[] : [], total: Number(answer.meta?.total) || 0, lastPage: Number(answer.meta?.lastPage) || page }
}

const money = (value: unknown) => {
  const number = Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(number) && number > 0 ? Math.round(number * 100) : 0
}
/** Роздрібна (рекомендована) ціна — не закупка. */
const isRetailName = (name: string) => /роздр|розн|рекоменд|ррц|rrp|retail/i.test(name)

/**
 * Закупка з кількох цін GPL: найменша з тих, що не «роздрібні/рекомендовані». Назви цін записуються в meta
 * підключення — власник бачить, яку ціну взято (у реальному прайсі назв ще не бачили).
 */
export function gplPurchase(prices: GplItem['prices']): { kopecks: number; name: string | null } {
  const list = (Array.isArray(prices) ? prices : []).map(price => ({ name: String(price?.name ?? '').trim(), kopecks: money(price?.price) })).filter(price => price.kopecks > 0)
  const candidates = list.filter(price => !isRetailName(price.name))
  const pick = (candidates.length ? candidates : list).sort((a, b) => a.kopecks - b.kopecks)[0]
  return pick ? { kopecks: pick.kopecks, name: pick.name || null } : { kopecks: 0, name: null }
}

/** Фото: повна https-адреса або шлях на сервері GPL. */
export function gplImage(value: unknown): string | null {
  const path = String(value ?? '').trim()
  if (!path) return null
  if (/^https:\/\//.test(path)) return path.slice(0, 600)
  if (/^\/?[\w./%-]+$/.test(path)) return (GPL_BASE + '/' + path.replace(/^\//, '')).slice(0, 600)
  return null
}

/** Рядок прайсу GPL → товар під замовлення. Без коду, артикула, назви чи ціни — пропускаємо. Ціну продажу ставить спільний запис. */
export function gplOffer(item: GplItem): GplOffer | null {
  const external = String(item.cid ?? '').trim().slice(0, 80)
  const number = String(item.article || item.partNumber || '').trim().slice(0, 120)
  const name = String(item.name ?? '').trim().slice(0, 400)
  const purchase = gplPurchase(item.prices).kopecks
  if (!external || !number || !code(number) || !name || !purchase) return null
  const stock = (Array.isArray(item.warehouses) ? item.warehouses : [])
    .map(w => ({ w: String(w?.name ?? '').trim().slice(0, 120), q: restQty(w?.quantity) })).filter(rest => rest.w && rest.q > 0)
  return {
    external_id: external, number, number_code: code(number).slice(0, 120), brand: String(item.brand ?? '').trim().slice(0, 120) || null, name,
    barcode: null, image_url: gplImage(item.imagePath), purchase_price: purchase, retail_price: 0, stock, total_qty: stock.reduce((sum, rest) => sum + rest.q, 0),
    description: String(item.description ?? '').trim().slice(0, 4000) || null, category_name: String(item.category ?? '').trim().slice(0, 200) || null,
  }
}
