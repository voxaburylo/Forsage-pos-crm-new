import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'

/**
 * Шлюз сайту forsage-tires.com (24.11.2026, контракт розробника сайту).
 * Сайт живе у своїй базі; програма керує ним через одну серверну функцію сайту — «шлюз».
 * Ключ шлюзу (SITE_API_KEY) є лише тут, на сервері програми: ні каса, ні веб його не бачать.
 * У базу сайту напряму не пишемо. Кожну зміну записуємо в журнал аудиту програми.
 */
export const SITE_GATEWAY_URL_DEFAULT = 'https://zzxueclhkhvwdmxflmyx.supabase.co/functions/v1/site-api'
export const SITE_GATEWAY_TIMEOUT_MS = 15_000

/** Дозволені дії: true — змінює щось на сайті (іде в журнал аудиту), false — лише читає. */
export const SITE_ACTIONS: Readonly<Record<string, boolean>> = {
  'orders.list': false, 'orders.update': true, 'orders.unseen_count': false,
  'customers.list': false,
  'reviews.list': false, 'reviews.moderate': true, 'reviews.delete': true,
  'products.site_fields.get': false, 'products.site_fields.set': true,
  // Адреса для завантаження — ще не зміна: фото з'являється на сайті лише після photos.attach.
  'photos.upload_url': false, 'photos.attach': true, 'photos.remove': true,
  'categories.list': false, 'categories.upsert': true, 'categories.delete': true,
  'banners.list': false, 'banners.upsert': true, 'banners.delete': true,
  'promos.list': false, 'promos.upsert': true, 'promos.delete': true,
  'home.get': false, 'home.set': true,
  'pages.list': false, 'pages.upsert': true, 'pages.delete': true,
  'settings.get': false, 'settings.set': true,
}

export const SITE_SETTING_KEYS: readonly string[] = ['contact_phone1', 'contact_phone2', 'contact_address', 'contact_viber', 'contact_telegram',
  'seo_title', 'seo_description', 'legal_seller_name', 'legal_seller_code', 'legal_seller_address', 'legal_seller_email', 'ga_measurement_id', 'fb_pixel_id']

/** Ціни, які сайту не показуємо ніколи: такі поля не йдуть на шлюз ні в якій дії, на будь-якій глибині. */
const FORBIDDEN_FIELD = /^(purchase_price|wholesale_price|min_price|buy_price|cost|cost_price)$/i
const MAX_PARAMS_BYTES = 512 * 1024

function hasForbiddenField(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 8) return false
  if (Array.isArray(value)) return value.some(item => hasForbiddenField(item, depth + 1))
  return Object.entries(value).some(([key, inner]) => FORBIDDEN_FIELD.test(key) || hasForbiddenField(inner, depth + 1))
}

/** Перевірка запиту до того, як він піде на сайт. Повертає параметри, які можна передати. */
export function checkSiteCall(action: unknown, params: unknown): { action: string; params: Record<string, unknown>; changes: boolean } {
  if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(SITE_ACTIONS, action)) throw new AppError('VALIDATION_ERROR', 'Невідома дія для сайту', 422)
  if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) throw new AppError('VALIDATION_ERROR', 'Некоректні параметри дії', 422)
  const clean = { ...(params as Record<string, unknown> | undefined) }
  delete clean.action
  if (JSON.stringify(clean).length > MAX_PARAMS_BYTES) throw new AppError('VALIDATION_ERROR', 'Завеликий запит до сайту', 422)
  if (hasForbiddenField(clean)) throw new AppError('VALIDATION_ERROR', 'Закупівельні, оптові й мінімальні ціни на сайт не передаються', 422)
  if (action === 'settings.set') {
    const values = clean.values
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new AppError('VALIDATION_ERROR', 'Некоректні налаштування сайту', 422)
    const unknown = Object.keys(values).filter(key => !SITE_SETTING_KEYS.includes(key))
    if (unknown.length) throw new AppError('VALIDATION_ERROR', 'Невідоме налаштування сайту: ' + unknown.join(', '), 422)
  }
  return { action, params: clean, changes: SITE_ACTIONS[action] }
}

export interface SiteGatewayDeps { fetchImpl?: typeof fetch; key?: string; url?: string }

/** Запит на шлюз сайту. Помилки — людською мовою: їх бачить менеджер у розділі «Сайт». */
export async function callSiteGateway(action: string, params: Record<string, unknown>, deps: SiteGatewayDeps = {}): Promise<unknown> {
  const key = deps.key ?? process.env.SITE_API_KEY ?? ''
  const url = deps.url ?? process.env.SITE_API_URL ?? SITE_GATEWAY_URL_DEFAULT
  if (!key) throw new AppError('SITE_GATEWAY_NOT_CONFIGURED', 'Звʼязок із сайтом ще не налаштовано: на сервері програми немає ключа сайту (SITE_API_KEY).', 503)
  let response: Response
  try {
    response = await (deps.fetchImpl ?? fetch)(url, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-site-key': key },
      body: JSON.stringify({ ...params, action }),
      signal: AbortSignal.timeout(SITE_GATEWAY_TIMEOUT_MS),
    })
  } catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new AppError('SITE_GATEWAY_UNREACHABLE', timeout ? 'Сайт не відповів за 15 секунд. Спробуйте ще раз.' : 'Немає звʼязку із сайтом. Спробуйте ще раз за хвилину.', 502)
  }
  type Answer = { ok?: unknown; data?: unknown; error?: unknown }
  const body = await response.json().then(value => value as Answer | null, () => null)
  if (response.status === 401 || response.status === 403) throw new AppError('SITE_GATEWAY_KEY_REJECTED', 'Сайт не прийняв ключ. Перевірте SITE_API_KEY на сервері програми.', 502)
  if (response.status === 404 && !body) throw new AppError('SITE_GATEWAY_NOT_READY', 'Шлюз сайту ще не працює (адреса не відповідає).', 502)
  if (!body || typeof body !== 'object') throw new AppError('SITE_GATEWAY_BAD_ANSWER', `Сайт відповів незрозуміло (код ${response.status}).`, 502)
  if (body.ok !== true) throw new AppError('SITE_GATEWAY_REFUSED', 'Сайт відмовив: ' + (typeof body.error === 'string' && body.error ? body.error.slice(0, 300) : `код ${response.status}`), 409)
  return body.data ?? null
}

/** Коротко, що саме змінили, — для журналу аудиту. Тексти сторінок і описів у журнал не кладемо цілими. */
export function auditSummary(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') out[key] = value.length > 200 ? value.slice(0, 200) + '…' : value
    else if (Array.isArray(value)) out[key] = `список (${value.length})`
    else if (value && typeof value === 'object') out[key] = Object.keys(value).slice(0, 30)
    else out[key] = value
  }
  return out
}

export async function writeSiteAudit(user: { id: string; tenant_id: string }, action: string, params: Record<string, unknown>): Promise<void> {
  const label = String(params.id ?? params.program_product_id ?? params.title ?? params.name ?? '').slice(0, 300) || null
  await pool.query(
    `INSERT INTO audit_log (tenant_id, user_id, user_name, action, entity_type, entity_id, entity_label, old_value, new_value, note)
     SELECT $1, $2, COALESCE((SELECT raw_user_meta_data->>'full_name' FROM auth.users WHERE id = $2), 'Користувач'),
            $3, 'site', NULL, $4, NULL, $5::jsonb, 'Розділ «Сайт»'`,
    [user.tenant_id, user.id, ('SITE_' + action.replace(/\./g, '_').toUpperCase()).slice(0, 50), label, JSON.stringify(auditSummary(params))],
  )
}

/**
 * Дія з розділу «Сайт»: перевірка → шлюз → запис у журнал (лише для змін і лише коли сайт її прийняв).
 * Журнал не вдалося записати — це помилка: зміна на сайті без сліду в програмі не має лишатись непоміченою.
 */
export async function siteGatewayAction(user: { id: string; tenant_id: string }, rawAction: unknown, rawParams: unknown, deps: SiteGatewayDeps = {}) {
  const { action, params, changes } = checkSiteCall(rawAction, rawParams)
  const data = await callSiteGateway(action, params, deps)
  if (changes) {
    try { await writeSiteAudit(user, action, params) } catch {
      throw new AppError('SITE_AUDIT_FAILED', 'Зміну на сайті зроблено, але запис у журнал аудиту не зберігся. Повідомте власника.', 500)
    }
  }
  return data
}

/**
 * Місце під Telegram-бота (поки нічого не робить — рішення 24.11.2026: бот пізніше).
 * Коли бот зʼявиться, сюди піде одне повідомлення про нове замовлення із сайту; викликати — із фонової перевірки
 * нових замовлень (orders.list з since), яка запамʼятовує останнє надіслане.
 */
export async function notifyNewSiteOrder(_order: { id: string; customer_name?: string; total?: number }): Promise<void> {
  // навмисно порожньо
}
